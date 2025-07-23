// Cloudflare Worker entrypoint for KV-based bot/bus data storage
export interface Env {
  webbusdb: KVNamespace;
  // Environment variables for sensitive data
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  WEBHOOK_ID_TRIGGER?: string;
  WEBHOOK_ID_TELEGRAM?: string;
}

interface BusData {
  route_no: string;
  dir: number;
  lastbus: number;
  remaining?: number; // Stops away from the station
}

// Fetch bus information from the API
async function fetchBusInfo(stationId: string): Promise<BusData[]> {
  try {
    // Try direct API first, then fallback to proxy
    const apiUrl = `https://motransportinfo.com/its/getStopInfo.php?ref=1&id=${stationId}`;
    
    console.log('=== BUS API REQUEST ===');
    console.log('Station ID:', stationId);
    console.log('Full API URL:', apiUrl);
    console.log('========================');
    
    console.log('Fetching bus data from:', apiUrl);
    
    const response = await fetch(apiUrl, {
      headers: {
        'Cache-Control': 'no-cache',
        'User-Agent': 'Mozilla/5.0 (compatible; WebBusWorker/1.0)',
      },
    });

    console.log('Bus API response status:', response.status);
    
    if (!response.ok) {
      throw new Error(`Bus API request failed: ${response.status}`);
    }

    const responseText = await response.text();
    console.log('Bus API response:', responseText.substring(0, 200) + '...');
    
    // Check if response is HTML instead of JSON
    if (responseText.trim().startsWith('<') || responseText.includes('Title:')) {
      console.error('Bus API returned HTML instead of JSON');
      throw new Error('Bus API is currently unavailable');
    }
    
    try {
      const data: BusData[] = JSON.parse(responseText);
      console.log('=== PARSED API DATA ===');
      console.log('Raw data:', JSON.stringify(data, null, 2));
      console.log('Number of buses:', data.length);
      data.forEach((bus, index) => {
        console.log(`Bus ${index + 1}:`, {
          route_no: bus.route_no,
          dir: bus.dir,
          lastbus: bus.lastbus
        });
      });
      console.log('=====================');
      return Array.isArray(data) ? data : [];
    } catch (parseError) {
      console.error('Failed to parse JSON response:', parseError);
      throw new Error('Invalid response format from bus API');
    }
  } catch (error) {
    console.error('Error fetching bus info:', error);
    throw error;
  }
}

// Format bus data for display in "bus 11: 3 -> 7" format (stops away)
function formatBusData(busData: BusData[]): string {
  if (!busData || busData.length === 0) {
    return 'No bus information available at this station';
  }

  // Group buses by route number and direction
  const groupedBuses = busData.reduce((acc, bus) => {
    const key = `${bus.route_no}_${bus.dir}`;
    if (!acc[key]) {
      acc[key] = [];
    }
    acc[key].push(bus);
    return acc;
  }, {} as Record<string, BusData[]>);

  const results: string[] = [];
  
  for (const [key, buses] of Object.entries(groupedBuses)) {
    const [routeNo, dirStr] = key.split('_');
    const direction = dirStr === '0' ? 'Out' : 'In';
    
    // Sort buses by remaining stops (closest first)
    const sortedBuses = buses.sort((a, b) => {
      // If remaining data is available, use it
      if (a.remaining !== undefined && b.remaining !== undefined) {
        return a.remaining - b.remaining;
      }
      // Fallback to time-based sorting
      if (a.lastbus === -1 && b.lastbus === -1) return 0;
      if (a.lastbus === -1) return -1;
      if (b.lastbus === -1) return 1;
      return a.lastbus - b.lastbus;
    });
    
    if (sortedBuses.length === 1) {
      const bus = sortedBuses[0];
      if (bus.remaining !== undefined) {
        // Use stops format
        const stops = Math.round(bus.remaining * 10) / 10; // Round to 1 decimal
        results.push(`Bus ${routeNo} (${direction}): ${stops} stops`);
      } else if (bus.lastbus === -1) {
        results.push(`Bus ${routeNo} (${direction}): Running`);
      } else {
        results.push(`Bus ${routeNo} (${direction}): ${bus.lastbus}min`);
      }
    } else {
      // Multiple buses - show in "bus 11: 3 -> 7" format
      const distances = sortedBuses.map(bus => {
        if (bus.remaining !== undefined) {
          const stops = Math.round(bus.remaining * 10) / 10;
          return stops.toString();
        } else if (bus.lastbus === -1) {
          return 'Now';
        } else {
          return `${bus.lastbus}min`;
        }
      });
      
      if (distances.length >= 2) {
        results.push(`Bus ${routeNo} (${direction}): ${distances[0]} -> ${distances[1]}`);
      } else {
        results.push(`Bus ${routeNo} (${direction}): ${distances[0]}`);
      }
    }
  }
  
  return results.join('\n');
}

// Send message to Telegram
async function sendTelegramMessage(message: string, botToken: string, chatId: string): Promise<boolean> {
  try {
    const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const response = await fetch(telegramUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message
      })
    });
    return response.ok;
  } catch (error) {
    console.error('Telegram send error:', error);
    return false;
  }
}

// Simple monitoring state without persistent controllers
let isMonitoring = false;
let monitoringStartTime = 0;

// Start continuous bus monitoring
async function startBusMonitoring(
  stationId: string, 
  stationName: string, 
  busNumbers: string[], 
  botToken: string, 
  chatId: string
): Promise<void> {
  isMonitoring = true;
  
  for (let cycle = 1; cycle <= 20; cycle++) {
    // Check if monitoring was stopped
    if (!isMonitoring) {
      console.log('Monitoring stopped by user');
      break;
    }
    
    try {
      // Fetch current bus data
      const busData = await fetchBusInfo(stationId);
      
      // Filter by specific bus numbers if provided
      let filteredBusData = busData;
      if (busNumbers && busNumbers.length > 0 && busData.length > 0) {
        filteredBusData = busData.filter(bus => 
          busNumbers.some((num: string) => bus.route_no.includes(num))
        );
      }

      // Format the message
      const timestamp = new Date().toLocaleString('en-US', { 
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      
      const header = `Update ${cycle}/20 - ${stationName || stationId}\nTime: ${timestamp}\n\n`;
      const busInfo = formatBusData(filteredBusData);
      const message = header + busInfo;

      // Send to Telegram (only wait for timer after successful send)
      const success = await sendTelegramMessage(message, botToken, chatId);
      
      if (success) {
        console.log(`Cycle ${cycle} completed successfully`);
        
        // Wait 40 seconds before next cycle (only after successful API request)
        if (cycle < 20 && isMonitoring) {
          await new Promise(resolve => setTimeout(resolve, 40000));
        }
      } else {
        console.error(`Cycle ${cycle} failed to send to Telegram`);
        // Still continue to next cycle but don't wait if send failed
      }
      
    } catch (error) {
      console.error(`Monitoring cycle ${cycle} failed:`, error);
      // Continue with next cycle even if one fails
      if (error.message === 'Monitoring aborted') {
        break;
      }
    }
  }
  
  isMonitoring = false;
  console.log('Bus monitoring completed or stopped');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    // Add CORS headers for all responses
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    if (request.method === 'POST' && url.pathname === '/api/save') {
      const data = await request.json();
      // Save bots and busStops as JSON strings
      await env.webbusdb.put('bots', JSON.stringify(data.bots || []));
      await env.webbusdb.put('busStops', JSON.stringify(data.busStops || []));
      return new Response(JSON.stringify({ success: true }), { 
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (request.method === 'GET' && url.pathname === '/api/load') {
      const bots = await env.webbusdb.get('bots');
      const busStops = await env.webbusdb.get('busStops');
      return new Response(
        JSON.stringify({
          bots: bots ? JSON.parse(bots) : [],
          busStops: busStops ? JSON.parse(busStops) : [],
        }),
        { 
          status: 200, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      );
    }
    // Continuous bus monitoring endpoint
    if (request.method === 'POST' && url.pathname === '/api/fetch-bus') {
      try {
        const { stationId, stationName, busNumbers } = await request.json();
        
        if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
          return new Response(JSON.stringify({ error: 'Telegram not configured' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // Fetch real bus information (single call)
        console.log('Making single bus API call...');
        const busData = await fetchBusInfo(stationId);
        
        // Filter by specific bus numbers if provided
        let filteredBusData = busData;
        if (busNumbers && busNumbers.length > 0 && busData.length > 0) {
          filteredBusData = busData.filter(bus => 
            busNumbers.some((num: string) => bus.route_no.includes(num))
          );
        }

        // Format the message
        const timestamp = new Date().toLocaleString('en-US', { 
          timeZone: 'Asia/Shanghai',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        });
        
        const header = `Bus Update - ${stationName || stationId}\nTime: ${timestamp}\nLooking for: ${busNumbers?.join(', ') || 'All buses'}\n\n`;
        const busInfo = formatBusData(filteredBusData);
        const message = header + busInfo;
        
        // Send to Telegram
        console.log('Sending bus update to Telegram...');
        const success = await sendTelegramMessage(message, env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);

        // Store monitoring request in KV for cron processing
        const monitoringData = {
          stationId,
          stationName,
          busNumbers,
          startTime: Date.now(),
          cycleCount: 0,
          maxCycles: 20,
          interval: 10000, // 10 seconds - FOR TESTING
          active: true
        };
        
        const monitoringKey = `monitoring_${stationId}_${Date.now()}`;
        await env.webbusdb.put(monitoringKey, JSON.stringify(monitoringData));
        
        // Send first message immediately
        if (success) {
          console.log('First message sent, cron will handle remaining cycles');
        }
        
        return new Response(JSON.stringify({ 
          success: success, 
          message: success ? 'Started server-side monitoring - 20 cycles every 40 seconds' : 'Failed to start monitoring',
          monitoringKey: monitoringKey,
          busData: filteredBusData,
          timestamp: timestamp
        }), {
          status: success ? 200 : 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

      } catch (error) {
        return new Response(JSON.stringify({ 
          error: 'Failed to process request',
          details: error instanceof Error ? error.message : 'Unknown error'
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // Stop monitoring endpoint
    if (request.method === 'POST' && url.pathname === '/api/stop-monitoring') {
      try {
        // Stop all active monitoring sessions in KV
        const { keys } = await env.webbusdb.list({ prefix: 'monitoring_' });
        let stoppedCount = 0;
        
        for (const key of keys) {
          const monitoringDataStr = await env.webbusdb.get(key.name);
          if (monitoringDataStr) {
            const monitoringData = JSON.parse(monitoringDataStr);
            if (monitoringData.active) {
              // Delete the monitoring session completely
              await env.webbusdb.delete(key.name);
              console.log(`Deleted monitoring session: ${key.name}`);
              stoppedCount++;
            }
          }
        }
        
        return new Response(JSON.stringify({ 
          success: true, 
          message: `Stopped ${stoppedCount} active monitoring session(s)`,
          stoppedCount: stoppedCount
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({ 
          success: false,
          message: 'Failed to stop monitoring',
          details: error instanceof Error ? error.message : 'Unknown error'
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },

  // Cron trigger for monitoring
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    console.log('Cron trigger executed at:', new Date().toISOString());
    
    try {
      // Get all monitoring sessions
      const { keys } = await env.webbusdb.list({ prefix: 'monitoring_' });
      
      for (const key of keys) {
        const monitoringDataStr = await env.webbusdb.get(key.name);
        if (!monitoringDataStr) continue;
        
        const monitoringData = JSON.parse(monitoringDataStr);
        
        // Check if monitoring is still active
        if (!monitoringData.active) {
          console.log(`Deleting inactive monitoring session: ${key.name}`);
          await env.webbusdb.delete(key.name);
          continue;
        }
        
        // Check if we've reached max cycles
        if (monitoringData.cycleCount >= monitoringData.maxCycles) {
          console.log(`Monitoring completed for ${monitoringData.stationId}`);
          await env.webbusdb.delete(key.name);
          continue;
        }
        
        // Check if enough time has passed for next cycle
        const timeSinceStart = Date.now() - monitoringData.startTime;
        const expectedCycles = Math.floor(timeSinceStart / monitoringData.interval);
        
        if (expectedCycles > monitoringData.cycleCount) {
          // Time for next cycle
          try {
            const busData = await fetchBusInfo(monitoringData.stationId);
            
            // Filter by bus numbers
            let filteredBusData = busData;
            if (monitoringData.busNumbers && monitoringData.busNumbers.length > 0) {
              filteredBusData = busData.filter(bus => 
                monitoringData.busNumbers.some((num: string) => bus.route_no.includes(num))
              );
            }
            
            // Format message
            const cycleNum = monitoringData.cycleCount + 1;
            const timestamp = new Date().toLocaleString('en-US', { 
              timeZone: 'Asia/Shanghai',
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit'
            });
            
            const header = `Bus Update ${cycleNum}/20 - ${monitoringData.stationName || monitoringData.stationId}\nTime: ${timestamp}\nLooking for: ${monitoringData.busNumbers?.join(', ') || 'All buses'}\n\n`;
            const busInfo = formatBusData(filteredBusData);
            const message = header + busInfo;
            
            // Send to Telegram
            const success = await sendTelegramMessage(message, env.TELEGRAM_BOT_TOKEN!, env.TELEGRAM_CHAT_ID!);
            
            if (success) {
              console.log(`Cycle ${cycleNum} sent successfully for ${monitoringData.stationId}`);
              
              // Update cycle count
              monitoringData.cycleCount = cycleNum;
              await env.webbusdb.put(key.name, JSON.stringify(monitoringData));
            } else {
              console.error(`Failed to send cycle ${cycleNum} for ${monitoringData.stationId}`);
            }
            
          } catch (error) {
            console.error(`Error in monitoring cycle for ${monitoringData.stationId}:`, error);
          }
        }
      }
    } catch (error) {
      console.error('Cron execution error:', error);
    }
  }
};

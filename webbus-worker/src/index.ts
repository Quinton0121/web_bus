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
}

// Fetch bus information from the API
async function fetchBusInfo(stationId: string): Promise<BusData[]> {
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    // Try direct API first, then fallback to proxy
    const apiUrl = `https://motransportinfo.com/its/getStopInfo.php?ref=1&id=${stationId}&ts=${timestamp}`;
    
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

// Format bus data for display
function formatBusData(busData: BusData[]): string {
  if (!busData || busData.length === 0) {
    return 'No bus information available at this station';
  }

  return busData.map(bus => {
    const direction = bus.dir === 0 ? 'Outbound' : 'Inbound';
    const lastBusInfo = bus.lastbus === -1 ? 'Running' : `Last bus: ${bus.lastbus} min`;
    return `Bus ${bus.route_no} (${direction}): ${lastBusInfo}`;
  }).join('\n');
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

        // Try to fetch real bus information
        let busData: BusData[] = [];
        let busApiWorking = true;
        
        try {
          busData = await fetchBusInfo(stationId);
        } catch (busError) {
          console.error('Bus API failed:', busError);
          busApiWorking = false;
        }
        
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
          minute: '2-digit'
        });
        
        const header = `Station: ${stationName || stationId}\nTime: ${timestamp}\n\n`;
        
        let busInfo: string;
        if (!busApiWorking) {
          busInfo = `Bus API is currently unavailable.\nStation: ${stationName || stationId}\nLooking for: ${busNumbers?.join(', ') || 'All buses'}\n\nPlease try again later.`;
        } else {
          busInfo = formatBusData(filteredBusData);
          if (busNumbers && busNumbers.length > 0 && filteredBusData.length === 0 && busData.length > 0) {
            busInfo += `\n\nNote: No buses found for numbers ${busNumbers.join(', ')}\nAll available buses:\n${formatBusData(busData)}`;
          }
        }
        
        const message = header + busInfo;

        // Check if monitoring is stuck (auto-reset after 30 minutes)
        const now = Date.now();
        if (isMonitoring && (now - monitoringStartTime > 30 * 60 * 1000)) {
          console.log('Auto-resetting stuck monitoring session');
          isMonitoring = false;
        }
        
        // Start continuous monitoring (20 cycles, 40 seconds apart)
        if (isMonitoring) {
          return new Response(JSON.stringify({ 
            error: 'Monitoring already in progress. Stop current monitoring first.',
            isMonitoring: true,
            timeRemaining: Math.max(0, 30 * 60 * 1000 - (now - monitoringStartTime))
          }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
        
        monitoringStartTime = now;

        const monitoringPromise = startBusMonitoring(
          stationId, 
          stationName, 
          busNumbers, 
          env.TELEGRAM_BOT_TOKEN, 
          env.TELEGRAM_CHAT_ID
        );

        // Don't wait for completion, return immediately
        return new Response(JSON.stringify({ 
          success: true, 
          message: 'Started 20-cycle bus monitoring (40s after each successful request)',
          cycles: 20,
          interval: 40
        }), {
          status: 200,
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
        isMonitoring = false;
        return new Response(JSON.stringify({ 
          success: true, 
          message: 'Bus monitoring stopped'
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (error) {
        isMonitoring = false;
        return new Response(JSON.stringify({ 
          success: true,
          message: 'Monitoring state reset',
          details: error instanceof Error ? error.message : 'Unknown error'
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },
};

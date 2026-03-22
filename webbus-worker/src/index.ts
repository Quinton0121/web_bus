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
  [key: string]: any; // For nested bus data like "0", "1", etc.
}

// Fetch bus information from the API
async function fetchBusInfo(stationId: string): Promise<BusData[]> {
  try {
    // Try direct API first, then fallback to proxy
    const timestamp = Date.now();
    const apiUrl = `https://motransportinfo.com/its/getStopInfo.php?ref=1&id=${stationId}&_t=${timestamp}`;
    
    console.log('=== BUS API REQUEST ===');
    console.log('Station ID:', stationId);
    console.log('Timestamp:', new Date(timestamp).toISOString());
    console.log('Full API URL:', apiUrl);
    console.log('========================');
    
    console.log('Fetching bus data from:', apiUrl);
    
    const response = await fetch(apiUrl, {
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
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
      
      // Process and extract ALL buses from nested objects
      const processedData: BusData[] = [];
      
      data.forEach(bus => {
        // Check if there are nested bus objects with remaining data
        const nestedBuses: BusData[] = [];
        
        for (const key in bus) {
          if (!isNaN(Number(key)) && typeof bus[key] === 'object' && bus[key].remaining !== undefined) {
            nestedBuses.push({
              route_no: bus.route_no,
              dir: bus.dir,
              lastbus: bus.lastbus,
              remaining: bus[key].remaining
            });
            console.log(`Found bus ${bus.route_no} #${key}: ${bus[key].remaining} stops away`);
          }
        }
        
        if (nestedBuses.length > 0) {
          // Add all nested buses with remaining data
          processedData.push(...nestedBuses);
        } else {
          // Add the original bus without remaining data
          processedData.push({
            route_no: bus.route_no,
            dir: bus.dir,
            lastbus: bus.lastbus
          });
        }
      });
      
      console.log('=== PROCESSED DATA ===');
      console.log(`Total processed buses: ${processedData.length}`);
      processedData.forEach((bus, index) => {
        console.log(`Bus ${index + 1}:`, {
          route_no: bus.route_no,
          dir: bus.dir,
          lastbus: bus.lastbus,
          remaining: bus.remaining
        });
      });
      
      // Check for duplicate remaining values
      const remainingValues = processedData.filter(b => b.remaining !== undefined).map(b => b.remaining);
      if (remainingValues.length > 1) {
        console.log('Remaining values found:', remainingValues);
        const uniqueValues = [...new Set(remainingValues)];
        console.log('Unique remaining values:', uniqueValues);
        if (uniqueValues.length !== remainingValues.length) {
          console.log('WARNING: Duplicate remaining values detected!');
        }
      }
      console.log('=====================');
      
      return Array.isArray(processedData) ? processedData : [];
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
    const direction = dirStr === '0' ? '' : ' (In)';
    
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
        results.push(`Bus ${routeNo}${direction}: ${stops} stops`);
      } else if (bus.lastbus === -1) {
        results.push(`Bus ${routeNo}${direction}: Running`);
      } else {
        results.push(`Bus ${routeNo}${direction}: ${bus.lastbus}min`);
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
        results.push(`Bus ${routeNo}${direction}: ${distances[0]} -> ${distances[1]}`);
      } else {
        results.push(`Bus ${routeNo}${direction}: ${distances[0]}`);
      }
    }
  }
  
  return results.join('\n');
}

/** KV keys: `busSnapshot:${encodeURIComponent(stationId)}` — latest buses for website + Cron history */
const SNAPSHOT_PREFIX = 'busSnapshot:';

function snapshotKeyForStation(stationId: string): string {
  return SNAPSHOT_PREFIX + encodeURIComponent(String(stationId).trim());
}

async function saveBusSnapshot(env: Env, stationId: string, buses: BusData[]): Promise<void> {
  const key = snapshotKeyForStation(stationId);
  await env.webbusdb.put(
    key,
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      buses,
    })
  );
}

async function loadAllSnapshots(env: Env): Promise<Record<string, { updatedAt: string; buses: BusData[] }>> {
  const { keys } = await env.webbusdb.list({ prefix: SNAPSHOT_PREFIX });
  const snapshots: Record<string, { updatedAt: string; buses: BusData[] }> = {};
  for (const k of keys) {
    const raw = await env.webbusdb.get(k.name);
    if (!raw) continue;
    const stationId = decodeURIComponent(k.name.slice(SNAPSHOT_PREFIX.length));
    try {
      snapshots[stationId] = JSON.parse(raw);
    } catch {
      /* skip */
    }
  }
  return snapshots;
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

/** Reliable Asia/Macau clock (avoid `new Date(localeString)` which is engine-dependent). */
function getMacauCalendar(d: Date): {
  dayOfWeek: number;
  minutesFromMidnight: number;
  dateKey: string;
} {
  const dateKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Macau',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Macau',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const wd = get('weekday');
  const dayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const dayOfWeek = dayMap[wd.slice(0, 3)] ?? 0;

  const hour = parseInt(get('hour'), 10);
  const minute = parseInt(get('minute'), 10);
  const minutesFromMidnight = hour * 60 + minute;

  return { dayOfWeek, minutesFromMidnight, dateKey };
}

// Handle morning notifications (Monday to Friday)
async function handleMorningNotifications(env: Env, forceTest: boolean = false): Promise<void> {
  try {
    console.log('=== handleMorningNotifications START ===');

    const settingsStr = await env.webbusdb.get('morningSettings');
    if (!settingsStr) {
      console.log('[DEBUG] No morning settings found in KV. Exiting.');
      return;
    }

    const settings = JSON.parse(settingsStr);
    console.log('[DEBUG] Loaded settings:', JSON.stringify(settings));

    if (!settings.morningNotification?.enabled) {
      console.log('[DEBUG] Morning notifications are disabled in settings. Exiting.');
      return;
    }

    const stationId = String(settings.morningNotification.stationId || 'T408').trim();
    const busNumbers: string[] = Array.isArray(settings.morningNotification.busNumbers)
      ? settings.morningNotification.busNumbers.map((x: string) => String(x).trim())
      : ['11', '39'];

    const now = new Date();
    const { dayOfWeek, minutesFromMidnight: currentMinutes, dateKey: today } = getMacauCalendar(now);

    if (!forceTest && (dayOfWeek === 0 || dayOfWeek === 6)) {
      console.log(`[DEBUG] It's a weekend (day ${dayOfWeek}). Skipping notification.`);
      return;
    }

    const targetMinutes = settings.morningNotification.time;
    /** Only fire between target time and target+15min (cron is every minute). */
    const WINDOW_AFTER_TARGET = 15;

    console.log(
      `[DEBUG] Time check: Macau date ${today}, current minutes: ${currentMinutes}, target: ${targetMinutes}, window: +${WINDOW_AFTER_TARGET}m`
    );

    if (!forceTest && currentMinutes < targetMinutes) {
      console.log(`[DEBUG] Not time yet. Exiting.`);
      return;
    }

    if (!forceTest && currentMinutes > targetMinutes + WINDOW_AFTER_TARGET) {
      console.log(`[DEBUG] Past morning window (${WINDOW_AFTER_TARGET} min after target). Exiting.`);
      return;
    }

    const lastSentStr = await env.webbusdb.get('lastMorningNotification');
    console.log(`[DEBUG] 'lastMorningNotification' check: '${lastSentStr}' vs today '${today}'`);
    if (!forceTest && lastSentStr === today) {
      console.log('[DEBUG] Notification already sent today. Exiting.');
      return;
    }

    console.log(
      `[SUCCESS] All checks passed. Morning session for station ${stationId}, buses ${busNumbers.join(',')}`
    );

    const monitoringData = {
      stationId,
      stationName: stationId,
      busNumbers,
      startTime: Date.now(),
      cycleCount: 0,
      maxCycles: 20,
      interval: 40000,
      active: true,
      isMorningSession: true,
    };

    const monitoringKey = `monitoring_morning_${Date.now()}`;
    await env.webbusdb.put(monitoringKey, JSON.stringify(monitoringData));

    const busData = await fetchBusInfo(stationId);
    const filteredBusData = busData.filter((bus) =>
      busNumbers.some((num) => String(bus.route_no) === String(num))
    );

    const timestamp = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Macau',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(now);

    const busInfo = formatBusData(filteredBusData);
    const footer = `\n---------------\nStation: ${stationId}\nUpdate: 1/20 at ${timestamp}\nMorning Session: ${busNumbers.join(', ')}`;
    const message = `Good Morning Bus Update\n\n${busInfo}${footer}`;

    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
      console.error('[DEBUG] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing — cannot send morning notification.');
      await env.webbusdb.delete(monitoringKey);
      return;
    }

    const success = await sendTelegramMessage(message, env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);

    if (success) {
      await env.webbusdb.put('lastMorningNotification', today);
      monitoringData.cycleCount = 1;
      await env.webbusdb.put(monitoringKey, JSON.stringify(monitoringData));
      console.log('Morning monitoring session started successfully');
    } else {
      console.error('Failed to start morning monitoring session (Telegram send failed)');
      await env.webbusdb.delete(monitoringKey);
    }
  } catch (error) {
    console.error('Error in morning notification:', error);
  }
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
      console.log('/api/save endpoint reached');
      const data = await request.json();
      console.log('Saving data:', JSON.stringify(data));
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
      const snapshots = await loadAllSnapshots(env);
      return new Response(
        JSON.stringify({
          bots: bots ? JSON.parse(bots) : [],
          busStops: busStops ? JSON.parse(busStops) : [],
          snapshots,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    if (request.method === 'GET' && url.pathname === '/api/snapshots') {
      const snapshots = await loadAllSnapshots(env);
      return new Response(JSON.stringify({ snapshots }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    // Continuous bus monitoring endpoint (always returns busData when upstream API succeeds)
    if (request.method === 'POST' && url.pathname === '/api/fetch-bus') {
      try {
        const { stationId, stationName, busNumbers } = await request.json();

        if (!stationId || String(stationId).trim() === '') {
          return new Response(JSON.stringify({ error: 'stationId is required' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        console.log('Making single bus API call...');
        const busData = await fetchBusInfo(stationId);

        let filteredBusData = busData;
        if (busNumbers && busNumbers.length > 0 && busData.length > 0) {
          filteredBusData = busData.filter((bus) =>
            busNumbers.some((num: string) => bus.route_no === num.trim())
          );
          console.log(`Filtering for buses: ${busNumbers.join(', ')}`);
          console.log(`Found ${filteredBusData.length} matching buses out of ${busData.length} total`);
        }

        const timestamp = new Date().toLocaleString('en-US', {
          timeZone: 'Asia/Shanghai',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        });

        const busInfo = formatBusData(filteredBusData);
        const footer = `\n---------------\nStation: ${stationName || stationId}\nTime: ${timestamp}\nLooking for: ${busNumbers?.join(', ') || 'All buses'}`;
        const message = busInfo + footer;

        await saveBusSnapshot(env, stationId, filteredBusData);

        const telegramConfigured = !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
        let telegramSent = false;
        let monitoringKey: string | null = null;

        if (telegramConfigured) {
          console.log('Sending bus update to Telegram...');
          telegramSent = await sendTelegramMessage(message, env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);
          if (telegramSent) {
            const monitoringData = {
              stationId,
              stationName,
              busNumbers,
              startTime: Date.now(),
              cycleCount: 0,
              maxCycles: 20,
              interval: 10000,
              active: true
            };
            monitoringKey = `monitoring_${stationId}_${Date.now()}`;
            await env.webbusdb.put(monitoringKey, JSON.stringify(monitoringData));
            console.log('First message sent, cron will handle remaining cycles');
          }
        } else {
          console.log('Telegram not configured — returning bus data for web preview only');
        }

        let clientMessage: string;
        if (!telegramConfigured) {
          clientMessage = '已取得到站数据（本机未配置 Telegram，仅页面预览；后续轮询请用 Telegram 或部署后 Cron）';
        } else if (telegramSent) {
          clientMessage = '已发送到 Telegram，并已启动服务器端监控（Cron 续跑）';
        } else {
          clientMessage = '到站数据已显示在页面；Telegram 发送失败，未启动 Cron 监控';
        }

        return new Response(
          JSON.stringify({
            success: true,
            busData: filteredBusData,
            timestamp,
            telegramConfigured,
            telegramSent,
            monitoringKey,
            message: clientMessage
          }),
          {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          }
        );
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: 'Failed to process request',
            details: error instanceof Error ? error.message : 'Unknown error'
          }),
          {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          }
        );
      }
    }

    // Stop monitoring endpoint
    if (request.method === 'POST' && url.pathname === '/api/stop-monitoring') {
      try {
        // 1. Delete all active monitoring sessions in KV
        const { keys } = await env.webbusdb.list({ prefix: 'monitoring_' });
        let stoppedCount = 0;
        
        for (const key of keys) {
          await env.webbusdb.delete(key.name);
          console.log(`Deleted monitoring session: ${key.name}`);
          stoppedCount++;
        }

        // 2. Disable morning notifications
        const settingsStr = await env.webbusdb.get('morningSettings');
        if (settingsStr) {
          const settings = JSON.parse(settingsStr);
          if (settings.morningNotification) {
            settings.morningNotification.enabled = false;
            await env.webbusdb.put('morningSettings', JSON.stringify(settings));
            console.log('Morning notifications disabled.');
          }
        }
        
        return new Response(JSON.stringify({ 
          success: true, 
          message: `Stopped ${stoppedCount} active monitoring session(s) and disabled morning notifications.`,
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

    // Save morning notification settings
    if (request.method === 'POST' && url.pathname === '/api/save-morning-settings') {
      try {
        const settings = await request.json();
        console.log('Saving morning settings:', JSON.stringify(settings));
        await env.webbusdb.put('morningSettings', JSON.stringify(settings));
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: 'Failed to save settings' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // Load morning notification settings
    if (request.method === 'GET' && url.pathname === '/api/load-morning-settings') {
      try {
        const settings = await env.webbusdb.get('morningSettings');
        return new Response(settings || '{}', {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: 'Failed to load settings' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // Test morning notification endpoint
    if (request.method === 'POST' && url.pathname === '/api/test-morning-notification') {
      try {
        // Force trigger morning notification for testing
        await handleMorningNotifications(env, true); // Pass true to bypass checks
        return new Response(JSON.stringify({ success: true, message: 'Morning notification test triggered' }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({ 
          error: 'Failed to test morning notification',
          details: error instanceof Error ? error.message : 'Unknown error'
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // Debug endpoint to check current time and settings
    if (request.method === 'GET' && url.pathname === '/api/debug-morning') {
      try {
        const settingsStr = await env.webbusdb.get('morningSettings');
        const settings = settingsStr ? JSON.parse(settingsStr) : null;

        const now = new Date();
        const macau = getMacauCalendar(now);
        const currentMinutes = macau.minutesFromMidnight;

        const debugInfo = {
          currentTime: {
            utc: now.toISOString(),
            macauDateKey: macau.dateKey,
            minutes: currentMinutes,
            formatted: `${Math.floor(currentMinutes / 60)}:${(currentMinutes % 60).toString().padStart(2, '0')}`,
          },
          settings: settings,
          dayOfWeek: macau.dayOfWeek,
          isWeekday: macau.dayOfWeek >= 1 && macau.dayOfWeek <= 5,
          timeDiff: settings ? Math.abs(currentMinutes - settings.morningNotification.time) : 'N/A',
          lastMorningNotification: await env.webbusdb.get('lastMorningNotification'),
        };
        
        return new Response(JSON.stringify(debugInfo, null, 2), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({ 
          error: 'Debug failed',
          details: error instanceof Error ? error.message : 'Unknown error'
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // Reset morning notification flag for testing
    if (request.method === 'POST' && url.pathname === '/api/reset-morning-flag') {
      try {
        await env.webbusdb.delete('lastMorningNotification');
        return new Response(JSON.stringify({ success: true, message: 'Morning notification flag reset' }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: 'Failed to reset flag' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // Check if cron is running
    if (request.method === 'GET' && url.pathname === '/api/check-cron') {
      try {
        const lastExecution = await env.webbusdb.get('lastCronExecution');
        return new Response(JSON.stringify({ 
          lastCronExecution: lastExecution,
          currentTime: new Date().toISOString()
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: 'Failed to check cron' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // Get morning notification debug info
    if (request.method === 'GET' && url.pathname === '/api/morning-debug') {
      try {
        const debugInfo = await env.webbusdb.get('morningDebug');
        return new Response(debugInfo || '{}', {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: 'Failed to get debug info' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // Get cron debug info
    if (request.method === 'GET' && url.pathname === '/api/cron-debug') {
      try {
        const debugInfo = await env.webbusdb.get('cronDebug');
        return new Response(debugInfo || '{}', {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: 'Failed to get cron debug info' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },

  // Cron trigger for monitoring
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    const cronTime = new Date().toISOString();
    console.log('=== CRON TRIGGER EXECUTED ===');
    console.log('UTC Time:', cronTime);
    console.log('Event cron:', event.cron);
    
    try {
      // Check for morning notifications first (every minute)
      console.log('Calling handleMorningNotifications...');
      
      await handleMorningNotifications(env);
      
      console.log('handleMorningNotifications completed');
      
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
                monitoringData.busNumbers.some((num: string) => bus.route_no === num.trim())
              );
              console.log(`Cron filtering for buses: ${monitoringData.busNumbers.join(', ')}`);
              console.log(`Cron found ${filteredBusData.length} matching buses out of ${busData.length} total`);
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
            
            const busInfo = formatBusData(filteredBusData);

            await saveBusSnapshot(env, monitoringData.stationId, filteredBusData);

            // Different message format for morning sessions
            let footer, message;
            if (monitoringData.isMorningSession) {
              footer = `\n---------------\nStation: ${monitoringData.stationName || monitoringData.stationId}\nUpdate: ${cycleNum}/20 at ${timestamp}\nMorning Session: ${monitoringData.busNumbers?.join(', ') || 'All buses'}`;
              message = cycleNum === 1 ? `Good Morning Bus Update\n\n${busInfo}${footer}` : `${busInfo}${footer}`;
            } else {
              footer = `\n---------------\nStation: ${monitoringData.stationName || monitoringData.stationId}\nUpdate: ${cycleNum}/20 at ${timestamp}\nLooking for: ${monitoringData.busNumbers?.join(', ') || 'All buses'}`;
              message = busInfo + footer;
            }
            
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

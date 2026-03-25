// Cloudflare Worker entrypoint for KV-based bot/bus data storage
export interface Env {
  webbusdb: KVNamespace;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  UPDATE_SECRET?: string;
}

interface BusData {
  route_no: string;
  dir: number;
  lastbus: number;
  remaining?: number; // Stops away from the station
  [key: string]: any; // For nested bus data like "0", "1", etc.
}

// Fetch bus information from the API
async function fetchBusInfo(env: Env, stationId: string, busNumbers?: string[]): Promise<BusData[]> {
  const timestamp = Date.now();
  
  // Try to use the official DSAT API if we have credentials and specific routes to check
  if (busNumbers && busNumbers.length > 0) {
    try {
      const credsStr = await env.webbusdb.get('dsat_credentials');
      if (credsStr) {
        const creds = JSON.parse(credsStr);
        const processedData: BusData[] = [];
        let successCount = 0;

        for (const route of busNumbers) {
          const routeStr = String(route).trim();
          const dsatData = new URLSearchParams({
            action: 'dy',
            routeName: routeStr,
            dir: '0', // We fetch direction 0, ideally we should fetch both or know which one
            lang: 'zh-tw',
            routeType: '2',
            device: 'web'
          }).toString();

          const response = await fetch('https://bis.dsat.gov.mo:37812/macauweb/routestation/bus', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Origin': 'https://bis.dsat.gov.mo:37812',
              'Referer': `https://bis.dsat.gov.mo:37812/macauweb/routeLine.html?routeName=${routeStr}&direction=0&language=zh-tw&ver=3.8.6&routeType=2&fromDzzp=false`,
              'Cookie': creds.cookie,
              'token': creds.token
            },
            body: dsatData
          });

          if (response.ok) {
            const data = await response.json() as any;
            if (data && data.data && data.data.routeInfo) {
              successCount++;
              const routeInfo = data.data.routeInfo;
              // Find the queried station in the route
              const stationIndex = routeInfo.findIndex((info: any) => info.staCode === stationId);
              
              if (stationIndex !== -1) {
                // Look backwards from the station to find the closest bus
                let closestBus = null;
                let minStops = Infinity;

                for (let i = stationIndex; i >= 0; i--) {
                  const sInfo = routeInfo[i];
                  if (sInfo.busInfo && sInfo.busInfo.length > 0) {
                    const stopsAway = stationIndex - i;
                    if (stopsAway < minStops) {
                      minStops = stopsAway;
                      closestBus = sInfo.busInfo[0];
                    }
                  }
                }

                if (closestBus) {
                  processedData.push({
                    route_no: routeStr,
                    dir: 0,
                    lastbus: -1,
                    remaining: minStops
                  });
                }
              }
            }
          }
        }

        // Only return if we actually successfully queried the DSAT API for at least one route
        if (successCount > 0) {
          console.log(`[bus dsat] ${stationId} → ${processedData.length} row(s)`);
          (processedData as any)._source = 'DSAT Official API';
          return processedData;
        }
      }
    } catch (error) {
      console.error('Error fetching official DSAT API, falling back...', error);
    }
  }

  // Fallback to proxy
  const apiUrl = `https://motransportinfo.com/its/getStopInfo.php?ref=1&id=${stationId}&_t=${timestamp}`;

  try {
    const response = await fetch(apiUrl, {
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
        'User-Agent': 'Mozilla/5.0 (compatible; WebBusWorker/1.0)',
      },
    });

    if (!response.ok) {
      throw new Error(`Bus API request failed: ${response.status}`);
    }

    const responseText = await response.text();

    if (responseText.trim().startsWith('<') || responseText.includes('Title:')) {
      throw new Error('Bus API is currently unavailable');
    }

    let data: any;
    try {
      data = JSON.parse(responseText);
      // Adaptive extraction if DSAT wraps the array in an object
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        if (data.data && Array.isArray(data.data)) data = data.data;
        else if (data.result && Array.isArray(data.result)) data = data.result;
        else if (data.list && Array.isArray(data.list)) data = data.list;
      }
      
      if (!Array.isArray(data)) {
         console.log('Unrecognized JSON structure:', responseText.substring(0, 200));
         data = []; // Fallback empty
      }
    } catch {
      throw new Error('Invalid response format from bus API');
    }

    const processedData: BusData[] = [];

    for (const bus of data) {
      const nestedBuses: BusData[] = [];

      for (const key in bus) {
        if (!isNaN(Number(key)) && typeof bus[key] === 'object' && bus[key].remaining !== undefined) {
          nestedBuses.push({
            route_no: bus.route_no,
            dir: bus.dir,
            lastbus: bus.lastbus,
            remaining: bus[key].remaining,
          });
        }
      }

      if (nestedBuses.length > 0) {
        processedData.push(...nestedBuses);
      } else {
        processedData.push({
          route_no: bus.route_no,
          dir: bus.dir,
          lastbus: bus.lastbus,
        });
      }
    }

    console.log(`[bus proxy] ${stationId} → ${processedData.length} row(s)`);
    (processedData as any)._source = 'Old Proxy API';
    return processedData;
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
  const str = await env.webbusdb.get('all_snapshots');
  const all = str ? JSON.parse(str) : {};
  all[stationId] = {
    updatedAt: new Date().toISOString(),
    buses,
    source: (buses as any)._source || 'Unknown'
  };
  await env.webbusdb.put('all_snapshots', JSON.stringify(all));
}

async function loadAllSnapshots(env: Env): Promise<Record<string, { updatedAt: string; buses: BusData[] }>> {
  const str = await env.webbusdb.get('all_snapshots');
  return str ? JSON.parse(str) : {};
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

    const strM = await env.webbusdb.get('all_monitorings');
    const allM = strM ? JSON.parse(strM) : {};
    allM[stationId] = monitoringData;
    await env.webbusdb.put('all_monitorings', JSON.stringify(allM));

    const busData = await fetchBusInfo(env, stationId, busNumbers);
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
      delete allM[stationId];
      await env.webbusdb.put('all_monitorings', JSON.stringify(allM));
      return;
    }

    const success = await sendTelegramMessage(message, env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);

    if (success) {
      await env.webbusdb.put('lastMorningNotification', today);
      allM[stationId].cycleCount = 1;
      await env.webbusdb.put('all_monitorings', JSON.stringify(allM));
      console.log('Morning monitoring session started successfully');
    } else {
      console.error('Failed to start morning monitoring session (Telegram send failed)');
      delete allM[stationId];
      await env.webbusdb.put('all_monitorings', JSON.stringify(allM));
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

    if (request.method === 'POST' && url.pathname === '/api/update-credentials') {
      const authHeader = request.headers.get('Authorization');
      const expectedSecret = env.UPDATE_SECRET;
      
      if (!expectedSecret || authHeader !== `Bearer ${expectedSecret}`) {
        return new Response('Unauthorized', { status: 401, headers: corsHeaders });
      }
      
      try {
        const data = await request.json() as any;
        if (data.token && data.cookie) {
          await env.webbusdb.put('dsat_credentials', JSON.stringify({
            token: data.token,
            cookie: data.cookie,
            updatedAt: data.timestamp
          }));
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
        return new Response('Invalid data', { status: 400, headers: corsHeaders });
      } catch (e) {
        return new Response('Bad request', { status: 400, headers: corsHeaders });
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/save') {
      console.log('/api/save endpoint reached');
      const data = await request.json() as any;
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

    // Snapshot endpoint
    if (request.method === 'GET' && url.pathname === '/api/snapshots') {
      try {
        const strS = await env.webbusdb.get('all_snapshots');
        const snapshots: Record<string, any> = strS ? JSON.parse(strS) : {};

        const strM = await env.webbusdb.get('all_monitorings');
        let monitorings: Record<string, any> = strM ? JSON.parse(strM) : {};
        
        const globalStopStr = await env.webbusdb.get('global_stop_timestamp');
        const globalStop = globalStopStr ? parseInt(globalStopStr, 10) : 0;

        let monitoringsChanged = false;
        for (const [stationId, parsed] of Object.entries(monitorings)) {
           const p = parsed as any;
           if (!(p.active && p.startTime > globalStop && p.cycleCount < p.maxCycles)) {
              delete monitorings[stationId];
              monitoringsChanged = true;
           }
        }
        
        if (monitoringsChanged) {
           await env.webbusdb.put('all_monitorings', JSON.stringify(monitorings));
        }

        return new Response(JSON.stringify({ snapshots, monitorings }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({ 
          error: 'Failed to fetch snapshots',
          details: error instanceof Error ? error.message : 'Unknown error'
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }
    // Continuous bus monitoring endpoint (always returns busData when upstream API succeeds)
    if (request.method === 'POST' && url.pathname === '/api/fetch-bus') {
      try {
        const { stationId, stationName, busNumbers } = await request.json() as any;

        if (!stationId || String(stationId).trim() === '') {
          return new Response(JSON.stringify({ error: 'stationId is required' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        console.log('Making single bus API call...');
        const busData = await fetchBusInfo(env, stationId, busNumbers);

        let filteredBusData = busData;
        if (busNumbers && busNumbers.length > 0 && busData.length > 0) {
          filteredBusData = busData.filter(bus =>
            busNumbers.some((num: string) => String(bus.route_no || bus.num) === num.trim())
          );
          console.log(`Filtering for buses: ${busNumbers.join(', ')}`);
          console.log(`Found ${filteredBusData.length} matching buses out of ${busData.length} total`);
        }
        (filteredBusData as any)._source = (busData as any)._source;

        await saveBusSnapshot(env, stationId, filteredBusData);

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

        if (telegramConfigured && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
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
            const strM = await env.webbusdb.get('all_monitorings');
            const allM = strM ? JSON.parse(strM) : {};
            allM[stationId] = monitoringData;
            await env.webbusdb.put('all_monitorings', JSON.stringify(allM));
            monitoringKey = 'started';
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
        await env.webbusdb.delete('all_monitorings');
        let stoppedCount = 1;

        // Add a global stop timestamp because KV list() can take up to 60s to reflect newly created sessions
        await env.webbusdb.put('global_stop_timestamp', Date.now().toString());

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

    // Test DSAT raw API
    if (request.method === 'GET' && url.pathname === '/api/test-dsat') {
      try {
        const station = url.searchParams.get('station') || 'T408';
        const dsatUrl = `https://bis.dsat.gov.mo:37812/macauWeb/getStationData.html?stationCode=${station}`;
        
        const response = await fetch(dsatUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
          }
        });
        
        const text = await response.text();
        return new Response(text, {
          status: response.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({ 
          error: 'Failed to fetch DSAT',
          details: error instanceof Error ? error.message : 'Unknown error'
        }), {
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
      const strM = await env.webbusdb.get('all_monitorings');
      if (!strM) return;
      const monitorings = JSON.parse(strM);
      let monitoringsChanged = false;
      
      const globalStopStr = await env.webbusdb.get('global_stop_timestamp');
      const globalStop = globalStopStr ? parseInt(globalStopStr, 10) : 0;

      for (const [stationId, mData] of Object.entries(monitorings)) {
        const monitoringData = mData as any;
        
        if (!monitoringData.active || monitoringData.startTime <= globalStop || monitoringData.cycleCount >= monitoringData.maxCycles) {
          console.log(`Deleting inactive/zombie/completed monitoring session for: ${stationId}`);
          delete monitorings[stationId];
          monitoringsChanged = true;
          continue;
        }

        // Check if enough time has passed for next cycle
        const timeSinceStart = Date.now() - monitoringData.startTime;
        const expectedCycles = Math.floor(timeSinceStart / monitoringData.interval);
        
        if (expectedCycles > monitoringData.cycleCount) {
          // Time for next cycle
          try {
            const busData = await fetchBusInfo(env, monitoringData.stationId, monitoringData.busNumbers);
            
            // Filter by bus numbers
            let filteredBusData = busData;
            if (monitoringData.busNumbers && monitoringData.busNumbers.length > 0) {
              filteredBusData = busData.filter(bus => 
                monitoringData.busNumbers.some((num: string) => String(bus.route_no || bus.num) === num.trim())
              );
              console.log(`Cron filtering for buses: ${monitoringData.busNumbers.join(', ')}`);
              console.log(`Cron found ${filteredBusData.length} matching buses out of ${busData.length} total`);
            }
            (filteredBusData as any)._source = (busData as any)._source;
            
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
              monitoringsChanged = true;
            } else {
              console.error(`Failed to send cycle ${cycleNum} for ${monitoringData.stationId}`);
            }
            
          } catch (error) {
            console.error(`Error in monitoring cycle for ${monitoringData.stationId}:`, error);
          }
        }
      }
      
      if (monitoringsChanged) {
         await env.webbusdb.put('all_monitorings', JSON.stringify(monitorings));
      }
    } catch (error) {
      console.error('Cron execution error:', error);
    }
  }
};

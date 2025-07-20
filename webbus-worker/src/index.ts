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
    // Simple bus fetch endpoint with fallback
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

        // Send to Telegram
        const telegramUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
        const response = await fetch(telegramUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: message
          })
        });

        if (response.ok) {
          return new Response(JSON.stringify({ 
            success: true, 
            message: 'Test message sent to Telegram',
            busCount: 0
          }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        } else {
          return new Response(JSON.stringify({ error: 'Failed to send Telegram message' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

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

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },
};

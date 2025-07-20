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
  dir: string;
  remainings: string[];
}

interface BusApiResponse {
  bus_data: BusData[];
}

// Fetch bus information from the API
async function fetchBusInfo(stationId: string): Promise<BusData[]> {
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const apiUrl = `https://r.jina.ai/https://motransportinfo.com/its/getStopInfo.php?ref=1&id=${stationId}&ts=${timestamp}`;
    
    const response = await fetch(apiUrl, {
      headers: {
        'Cache-Control': 'no-cache',
        'User-Agent': 'Mozilla/5.0 (compatible; WebBusWorker/1.0)',
      },
    });

    if (!response.ok) {
      throw new Error(`Bus API request failed: ${response.status}`);
    }

    const data: BusApiResponse = await response.json();
    return data.bus_data || [];
  } catch (error) {
    console.error('Error fetching bus info:', error);
    throw error;
  }
}

// Format bus data for display
function formatBusData(busData: BusData[]): string {
  if (!busData || busData.length === 0) {
    return 'No bus information available';
  }

  return busData.map(bus => {
    const remainings = bus.remainings && bus.remainings.length > 0 
      ? bus.remainings.join(' -> ') 
      : 'No arrival info';
    return `Bus ${bus.route_no}-${bus.dir}: ${remainings}`;
  }).join('\n');
}

// Send message to Telegram
async function sendTelegramMessage(message: string, botToken: string, chatId: string): Promise<boolean> {
  try {
    const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
    
    const response = await fetch(telegramUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error('Telegram API error:', errorData);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Error sending Telegram message:', error);
    return false;
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

    // Existing endpoints
    if (request.method === 'POST' && url.pathname === '/api/save') {
      const data = await request.json();
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

    // New endpoint: Fetch bus info and send to Telegram
    if (request.method === 'POST' && url.pathname === '/api/fetch-bus') {
      try {
        const { stationId, stationName, busNumbers } = await request.json();
        
        if (!stationId) {
          return new Response(JSON.stringify({ error: 'Station ID is required' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // Check if required environment variables are set
        if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
          return new Response(JSON.stringify({ error: 'Telegram credentials not configured' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // Fetch bus information
        const busData = await fetchBusInfo(stationId);
        
        // Filter by specific bus numbers if provided
        let filteredBusData = busData;
        if (busNumbers && busNumbers.length > 0) {
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
        
        const header = `Station: ${stationName || `Stop ${stationId}`}\nTime: ${timestamp}\n\n`;
        const busInfo = formatBusData(filteredBusData);
        const message = header + busInfo;

        // Send to Telegram
        const success = await sendTelegramMessage(message, env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);
        
        if (success) {
          return new Response(JSON.stringify({ 
            success: true, 
            message: 'Bus information sent to Telegram',
            busCount: filteredBusData.length
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
        console.error('Error in fetch-bus endpoint:', error);
        return new Response(JSON.stringify({ 
          error: 'Failed to fetch bus information',
          details: error instanceof Error ? error.message : 'Unknown error'
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }
    
    return new Response('Not found', { status: 404, headers: corsHeaders });
  },
} satisfies ExportedHandler<Env>;
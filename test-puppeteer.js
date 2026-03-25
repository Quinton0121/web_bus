const puppeteer = require('puppeteer');

(async () => {
    // Launch a headless browser
    console.log('Launching browser...');
    const browser = await puppeteer.launch({
        headless: 'new', // Use the new headless mode
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

    // Set a realistic User-Agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // We want to intercept the specific API request
    let extractedToken = null;
    let extractedUrl = null;

    // Enable request interception
    await page.setRequestInterception(true);

    page.on('request', request => {
        const url = request.url();
        // Check if this is the target API request
        if (url.includes('/macauweb/routestation/bus')) {
            extractedUrl = url;
            const headers = request.headers();
            if (headers['token']) {
                extractedToken = headers['token'];
            }
        }
        request.continue();
    });

    console.log('Navigating to DSAT bus route page...');
    // Navigate to the page that triggers the bus request
    // We use route 11 as an example
    const targetPageUrl = 'https://bis.dsat.gov.mo:37812/macauweb/routeLine.html?routeName=11&direction=0&language=zh-tw&ver=3.8.6&routeType=2&fromDzzp=false';
    
    try {
        await page.goto(targetPageUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    } catch (error) {
        console.log('Navigation finished or timed out, checking for intercepted requests...');
    }

    // Wait a bit just in case the request is delayed
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Get the cookies for the domain
    const cookies = await page.cookies(targetPageUrl);
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    if (extractedToken) {
        console.log('\n--- EXTRACTED SUCCESS ---');
        console.log(`[Target URL]: ${extractedUrl}`);
        console.log(`[Token]: ${extractedToken}`);
        console.log(`[Cookies]: ${cookieString}`);
        console.log('-------------------------\n');
        
        const workerUrl = process.env.WORKER_URL;
        const secret = process.env.UPDATE_SECRET;

        if (workerUrl && secret) {
            console.log(`Sending credentials to ${workerUrl}/api/update-credentials...`);
            try {
                const response = await fetch(`${workerUrl}/api/update-credentials`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${secret}`
                    },
                    body: JSON.stringify({
                        token: extractedToken,
                        cookie: cookieString,
                        timestamp: new Date().toISOString()
                    })
                });
                
                if (response.ok) {
                    console.log('Successfully updated credentials in Cloudflare KV!');
                } else {
                    console.error('Failed to update credentials:', await response.text());
                }
            } catch (error) {
                console.error('Network error updating credentials:', error);
            }
        } else {
            console.log('WORKER_URL or UPDATE_SECRET not set. Skipping sending to KV.');
            console.log('You can now use these in your test.js script:');
            console.log(`\nHeaders to add:
{
  'Cookie': '${cookieString}',
  'token': '${extractedToken}',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Origin': 'https://bis.dsat.gov.mo:37812',
  'Referer': '${targetPageUrl}'
}`);
        }
    } else {
        console.log('\nFailed to intercept the token. The site might have detected the headless browser or the request was not made.');
    }

    await browser.close();
})();

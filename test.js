const https = require('https');

const data = new URLSearchParams({
  action: 'dy',
  routeName: '11',
  dir: '0',
  lang: 'zh-tw',
  routeType: '2',
  device: 'web'
}).toString();

const options = {
  hostname: 'bis.dsat.gov.mo',
  port: 443,
  path: '/macauweb/routestation/bus',
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'Content-Length': Buffer.byteLength(data),
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Origin': 'https://bis.dsat.gov.mo',
    'Referer': 'https://bis.dsat.gov.mo/macauweb/routeLine.html?routeName=11&direction=0&language=zh-tw&ver=3.8.6&routeType=2&fromDzzp=false'
  }
};

const req = https.request(options, (res) => {
  console.log(`STATUS: ${res.statusCode}`);
  let responseData = '';

  res.on('data', (chunk) => {
    responseData += chunk;
  });

  res.on('end', () => {
    try {
      console.log('Response:', JSON.parse(responseData));
    } catch (e) {
      console.log('Raw Response:', responseData);
    }
  });
});

req.on('error', (e) => {
  console.error(`Problem with request: ${e.message}`);
});

req.write(data);
req.end();

async function test() {
  const url = 'https://webbus-worker.quinton0121.workers.dev/api/fetch-bus';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stationId: 'T408',
        busNumbers: ['11,39']
      })
    });
    console.log('Status:', res.status);
    const text = await res.text();
    console.log('Response:', text);
  } catch (err) {
    console.error('Error:', err);
  }
}
test();

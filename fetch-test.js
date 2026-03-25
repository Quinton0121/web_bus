async function test() {
  const url = 'https://webbus-worker.quinton0121.workers.dev/api/snapshots';
  try {
    const res = await fetch(url);
    console.log('Status:', res.status);
    const text = await res.text();
    console.log('Response:', text.slice(0, 300));
  } catch (err) {
    console.error('Error:', err);
  }
}
test();

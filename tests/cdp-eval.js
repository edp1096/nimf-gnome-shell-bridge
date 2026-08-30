#!/usr/bin/env node

const [port, expression] = process.argv.slice(2);
if (!port || !expression) {
  console.error('usage: cdp-eval.js PORT EXPRESSION');
  process.exit(2);
}

const targets = await fetch(`http://127.0.0.1:${port}/json/list`)
  .then(response => response.json());
const target = targets.find(item =>
  item.type === 'page' && item.url.startsWith('https://codepen.io/pen/'));
if (!target) {
  console.error('CodePen page target not found');
  process.exit(1);
}

const socket = new WebSocket(target.webSocketDebuggerUrl);
const response = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('CDP timeout')), 10000);

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
    }));
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id !== 1)
      return;
    clearTimeout(timeout);
    resolve(message);
  });
  socket.addEventListener('error', reject);
});
socket.close();

if (response.error || response.result?.exceptionDetails) {
  console.error(JSON.stringify(response, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(response.result.result.value));

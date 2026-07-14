import { sha256 } from 'js-sha256';

let hashInstance: any = null;
let chunkCount = 0;

self.onmessage = (e: MessageEvent) => {
  const { type, chunk } = e.data;
  
  if (type === 'init') {
    hashInstance = sha256.create();
    chunkCount = 0;
    self.postMessage({ type: 'inited' });
  } else if (type === 'update') {
    if (hashInstance && chunk) {
      hashInstance.update(chunk);
      chunkCount++;
    }
  } else if (type === 'finish') {
    if (hashInstance) {
      const result = hashInstance.hex();
      self.postMessage({ type: 'result', hash: result, chunkCount });
      hashInstance = null;
    }
  }
};

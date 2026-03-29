import { processMarket } from './processMarket';

self.onmessage = function(e) {
  const { type, requestId } = e.data;

  if (type === 'PROCESS_ALL') {
    try {
      const { markets } = e.data;
      const results = markets.map(m => processMarket(m));
      self.postMessage({ type: 'COMPLETE', markets: results, requestId });
    } catch (err) {
      self.postMessage({ type: 'ERROR', message: err.message, requestId });
    }
  }
};

'use client';

import { useEffect, useState } from 'react';
import { initialize, decode_bc1 } from 'texture2ddecoder-wasm';

export default function TextureViewer() {
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Only initialize in the browser
    if (typeof window === 'undefined') return;

    // Initialize with CDN (no setup required!)
    initialize({ wasmPath: 'https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.0/wasm' })
      .then(() => {
        console.log('Texture decoder initialized from CDN');
        setIsReady(true);
      })
      .catch((err) => {
        console.error('Failed to initialize:', err);
        setError(err.message);
      });
  }, []);

  if (error) {
    return (
      <div className="p-6 text-red-600">
        <h2 className="text-xl font-bold">Error</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (!isReady) {
    return (
      <div className="p-6">
        <h2 className="text-xl font-bold">Loading...</h2>
        <p>Initializing texture decoder...</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Texture Decoder</h1>
      <p className="text-green-600 font-semibold">✓ Ready to decode textures!</p>
      {/* Add your texture decoding UI here */}
    </div>
  );
}


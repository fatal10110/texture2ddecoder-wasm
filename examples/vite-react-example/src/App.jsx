import { useEffect, useState } from "react";
import { initialize, decode_bc1 } from "texture2ddecoder-wasm";

function App() {
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    // Initialize the WASM module from CDN (no setup required!)
    initialize({
      wasmPath: "https://cdn.jsdelivr.net/npm/texture2ddecoder-wasm@1.2.1/wasm",
    })
      .then(() => {
        console.log("Texture decoder initialized from CDN!");
        setIsReady(true);
      })
      .catch((err) => {
        console.error("Failed to initialize:", err);
        setError(err.message);
      });
  }, []);

  const handleDecode = async () => {
    if (!isReady) return;

    try {
      // Example: decode some texture data
      const textureData = new Uint8Array(/* your compressed texture data */);
      const width = 512;
      const height = 512;

      const decoded = await decode_bc1(textureData, width, height);

      if (decoded) {
        console.log("Decoded texture:", decoded);
        // decoded is a Uint8Array with BGRA pixel data
        // Use it with canvas, WebGL, etc.
      }
    } catch (err) {
      console.error("Decode error:", err);
    }
  };

  if (error) {
    return (
      <div style={{ padding: "20px", color: "red" }}>
        <h2>Error</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (!isReady) {
    return (
      <div style={{ padding: "20px" }}>
        <h2>Loading texture decoder...</h2>
        <p>Initializing WebAssembly module...</p>
      </div>
    );
  }

  return (
    <div style={{ padding: "20px" }}>
      <h1>Texture Decoder Ready!</h1>
      <button onClick={handleDecode}>Decode Sample Texture</button>
      <p>The WASM module is initialized and ready to decode textures.</p>
    </div>
  );
}

export default App;

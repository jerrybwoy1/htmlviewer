/* ===== DEBOOGER2000 — local ZIP reader =====
   Browser-native ZIP support with no outside CDN dependency. */

(function () {
  'use strict';
  if (window.JSZip) return;

  function readUint16(view, offset) { return view.getUint16(offset, true); }
  function readUint32(view, offset) { return view.getUint32(offset, true); }
  function decodeText(bytes) { return new TextDecoder('utf-8').decode(bytes); }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('This browser cannot open compressed ZIP files without a little extra help. Try a newer version of Safari or Chrome.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function loadAsync(input) {
    const buffer = input instanceof ArrayBuffer ? input : await input.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);

    let endOfDirectory = -1;
    const searchStart = Math.max(0, bytes.length - 65557);
    for (let i = bytes.length - 22; i >= searchStart; i--) {
      if (readUint32(view, i) === 0x06054b50) { endOfDirectory = i; break; }
    }
    if (endOfDirectory < 0) throw new Error('This does not look like a real ZIP file.');

    const fileCount = readUint16(view, endOfDirectory + 10);
    const centralDirOffset = readUint32(view, endOfDirectory + 16);
    const files = {};
    let pos = centralDirOffset;

    for (let i = 0; i < fileCount; i++) {
      if (pos + 46 > bytes.length || readUint32(view, pos) !== 0x02014b50) throw new Error('The list of files inside this ZIP looks damaged.');
      const flags = readUint16(view, pos + 8);
      const method = readUint16(view, pos + 10);
      const compressedSize = readUint32(view, pos + 20);
      const nameLength = readUint16(view, pos + 28);
      const extraLength = readUint16(view, pos + 30);
      const commentLength = readUint16(view, pos + 32);
      const localHeaderOffset = readUint32(view, pos + 42);
      const name = decodeText(bytes.slice(pos + 46, pos + 46 + nameLength));
      const isDirectory = name.endsWith('/');
      files[name] = {
        name,
        dir:isDirectory,
        async: async function(type){
          if (isDirectory) return type === 'blob' ? new Blob([]) : new Uint8Array();
          if (flags & 1) throw new Error('This ZIP file is password-protected, so it cannot be opened here.');
          if (localHeaderOffset + 30 > bytes.length || readUint32(view, localHeaderOffset) !== 0x04034b50) throw new Error('One of the files inside this ZIP has a damaged starting point.');
          const localNameLength = readUint16(view, localHeaderOffset + 26);
          const localExtraLength = readUint16(view, localHeaderOffset + 28);
          const start = localHeaderOffset + 30 + localNameLength + localExtraLength;
          const end = start + compressedSize;
          if (end > bytes.length) throw new Error('One of the files inside this ZIP is cut off partway through.');
          const packed = bytes.slice(start, end);
          let unpacked;
          if (method === 0) unpacked = packed;
          else if (method === 8) unpacked = await inflateRaw(packed);
          else throw new Error('This ZIP was packed in a way this browser cannot open.');
          if (type === 'blob') return new Blob([unpacked]);
          if (type === 'uint8array') return unpacked;
          if (type === 'arraybuffer') return unpacked.buffer.slice(unpacked.byteOffset, unpacked.byteOffset + unpacked.byteLength);
          if (type === 'text' || type === 'string') return decodeText(unpacked);
          return new Blob([unpacked]);
        }
      };
      pos += 46 + nameLength + extraLength + commentLength;
    }
    return { files };
  }

  window.JSZip = { loadAsync };
})();

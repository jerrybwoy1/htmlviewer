(function () {
  'use strict';

  const MAX_TEXT_FILE = 2000000;
  const READABLE_KINDS = new Set(['html', 'css', 'js', 'ts', 'jsx', 'tsx', 'json', 'svg', 'other']);

  function shouldSkipPath(path) {
    const norm = window.Debooger.normalizePath(path);
    return norm.startsWith('__macosx/') || norm.endsWith('.ds_store') || norm.includes('/.git/') || norm.startsWith('.git/') || norm.includes('/node_modules/') || norm.startsWith('node_modules/');
  }

  function baseName(path) {
    const norm = String(path || '').replace(/\\/g, '/');
    const parts = norm.split('/');
    return parts[parts.length - 1] || norm;
  }

  function mimeFromPath(path) {
    const lower = String(path || '').toLowerCase();
    if (/\.html?$/.test(lower)) return 'text/html';
    if (/\.css$/.test(lower)) return 'text/css';
    if (/\.(m?js|cjs)$/.test(lower)) return 'text/javascript';
    if (/\.json$/.test(lower)) return 'application/json';
    if (/\.svg$/.test(lower)) return 'image/svg+xml';
    if (/\.png$/.test(lower)) return 'image/png';
    if (/\.jpe?g$/.test(lower)) return 'image/jpeg';
    if (/\.gif$/.test(lower)) return 'image/gif';
    if (/\.webp$/.test(lower)) return 'image/webp';
    if (/\.avif$/.test(lower)) return 'image/avif';
    if (/\.ico$/.test(lower)) return 'image/x-icon';
    if (/\.woff2$/.test(lower)) return 'font/woff2';
    if (/\.woff$/.test(lower)) return 'font/woff';
    if (/\.ttf$/.test(lower)) return 'font/ttf';
    if (/\.otf$/.test(lower)) return 'font/otf';
    if (/\.pdf$/.test(lower)) return 'application/pdf';
    if (/\.mp4$/.test(lower)) return 'video/mp4';
    if (/\.webm$/.test(lower)) return 'video/webm';
    if (/\.mp3$/.test(lower)) return 'audio/mpeg';
    if (/\.wav$/.test(lower)) return 'audio/wav';
    return 'application/octet-stream';
  }

  function sniffKind(path, declaredKind, content) {
    if (declaredKind !== 'other') return declaredKind;
    const trimmed = String(content || '').trimStart();
    if (/^(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(trimmed)) return 'html';
    return declaredKind;
  }

  function uniqueByPath(files) {
    const map = new Map();
    files.forEach(function (file) { map.set(window.Debooger.normalizePath(file.path), file); });
    return Array.from(map.values());
  }

  async function fileToProjectFile(file, pathOverride) {
    const displayPath = String(pathOverride || file.webkitRelativePath || file.name).replace(/\\/g, '/').replace(/^\/+/, '');
    const normalizedPath = window.Debooger.normalizePath(displayPath);
    let kind = window.Debooger.kindFromName(displayPath);
    let content = '';
    let readable = true;
    let skipReason = '';

    if (READABLE_KINDS.has(kind)) {
      if (file.size <= MAX_TEXT_FILE) content = await file.text();
      else {
        readable = false;
        skipReason = 'Text file is larger than the 2 MB browser source-analysis limit (' + file.size + ' bytes). It was kept for previewing but not marked passed or failed by source checks.';
      }
    }
    kind = sniffKind(displayPath, kind, content);

    return {
      id: String(file.lastModified || Date.now()) + '-' + normalizedPath,
      name: baseName(displayPath),
      path: displayPath,
      normalizedPath: normalizedPath,
      kind: kind,
      content: content,
      size: file.size,
      mime: file.type || mimeFromPath(displayPath),
      blob: file.slice ? file.slice(0, file.size, file.type || mimeFromPath(displayPath)) : file,
      readable: readable,
      skipReason: skipReason,
      source: 'upload'
    };
  }

  async function extractZip(file) {
    if (!window.JSZip || typeof window.JSZip.loadAsync !== 'function') throw new Error('ZIP support did not load. Reload the page and try again.');
    const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
    const extracted = [];
    const names = Object.keys(zip.files).filter(function (name) { return !zip.files[name].dir && !shouldSkipPath(name); });

    for (const displayPath of names) {
      const entry = zip.files[displayPath];
      const normalizedPath = window.Debooger.normalizePath(displayPath);
      let kind = window.Debooger.kindFromName(displayPath);
      const bytes = await entry.async('uint8array');
      const mime = mimeFromPath(displayPath);
      const blob = new Blob([bytes], { type: mime });
      let content = '';
      let readable = true;
      let skipReason = '';

      if (READABLE_KINDS.has(kind)) {
        if (bytes.byteLength <= MAX_TEXT_FILE) content = new TextDecoder('utf-8').decode(bytes);
        else {
          readable = false;
          skipReason = 'Text file is larger than the 2 MB browser source-analysis limit (' + bytes.byteLength + ' bytes). It remains available to the preview but source checks are marked not tested.';
        }
      }
      kind = sniffKind(displayPath, kind, content);

      extracted.push({
        id: String(file.lastModified || Date.now()) + '-' + normalizedPath,
        name: baseName(displayPath),
        path: displayPath.replace(/\\/g, '/').replace(/^\/+/, ''),
        normalizedPath: normalizedPath,
        kind: kind,
        content: content,
        size: bytes.byteLength,
        mime: mime,
        blob: blob,
        readable: readable,
        skipReason: skipReason,
        source: 'zip'
      });
    }
    return extracted;
  }

  function detectProject(files) {
    const messages = [];
    const packageFile = files.find(function (file) { return file.kind === 'json' && window.Debooger.normalizePath(file.path).endsWith('package.json') && file.readable !== false; });
    let pkg = {};
    let deps = {};
    if (packageFile) {
      try {
        pkg = JSON.parse(packageFile.content || '{}');
        deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
      } catch (error) {
        messages.push('package.json could not be parsed. The source audit will show the exact problem.');
      }
    }

    const hasReact = Boolean(deps.react) || files.some(function (file) { return file.kind === 'jsx' || file.kind === 'tsx'; });
    const hasVite = Boolean(deps.vite) || files.some(function (file) { return /(^|\/)vite\.config\.[^/]+$/i.test(file.path); });
    const hasElectron = Boolean(deps.electron) || Boolean(pkg.main && /\.(c?js|mjs)$/i.test(pkg.main));
    const htmlFiles = files.filter(function (file) { return file.kind === 'html'; });
    const indexCandidates = htmlFiles.filter(function (file) { return /(^|\/)index\.html?$/i.test(file.path); }).sort(function (a, b) { return a.path.split('/').length - b.path.split('/').length; });
    const entryPoint = indexCandidates[0] || htmlFiles[0] || null;

    let framework = 'Plain HTML/CSS/JavaScript';
    let projectType = htmlFiles.length ? 'html-project' : 'mixed-files';
    if (hasReact && hasVite) { framework = 'React + Vite'; projectType = htmlFiles.length ? 'react-built-or-hybrid' : 'react-source'; }
    else if (hasReact) { framework = 'React source'; projectType = htmlFiles.length ? 'react-hybrid' : 'react-source'; }
    if (hasElectron) { framework += ' + Electron'; projectType = 'electron-project'; }

    if (!htmlFiles.length && hasReact) messages.push('React source was detected but no HTML page is available yet. Source checks will run; runtime preview requires a browser-ready entry page or a supported build step.');
    else if (!htmlFiles.length) messages.push('No HTML page was found, so runtime rendering is not available. Source checks will still run where possible.');
    if (hasElectron) messages.push('Electron project detected. Browser-renderable pages can be tested here; native Electron APIs are reported as not tested rather than passed.');

    return { projectType, framework, entryPoint: entryPoint ? entryPoint.path : undefined, hasReact, hasVite, hasElectron, packageJson: pkg, messages };
  }

  async function loadProjectFiles(inputFiles) {
    const messages = [];
    const loaded = [];
    for (const file of inputFiles) {
      const relPath = file.webkitRelativePath || file.name;
      if (shouldSkipPath(relPath)) continue;
      const kind = window.Debooger.kindFromName(file.name);
      if (kind === 'archive') {
        if (!/\.zip$/i.test(file.name)) { messages.push(file.name + ' is an archive format this browser build cannot extract. ZIP is supported.'); continue; }
        const extracted = await extractZip(file);
        loaded.push.apply(loaded, extracted);
        messages.push('Opened ' + extracted.length + ' file(s) from ' + file.name + '.');
      } else loaded.push(await fileToProjectFile(file));
    }
    const merged = uniqueByPath(loaded);
    const detection = detectProject(merged);
    return { files: merged, detection, messages: messages.concat(detection.messages) };
  }

  async function readEntryAsFiles(entry, basePath) {
    if (!entry) return [];
    if (entry.isFile) {
      const file = await new Promise(function (resolve, reject) { entry.file(resolve, reject); });
      const path = String(basePath || entry.fullPath || file.name).replace(/\\/g, '/').replace(/^\/+/, '');
      try { Object.defineProperty(file, 'webkitRelativePath', { value: path, configurable: true }); }
      catch (error) { file.__deboogerPath = path; }
      return [{ file, path }];
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      const collected = [];
      while (true) {
        const entries = await new Promise(function (resolve, reject) { reader.readEntries(resolve, reject); });
        if (!entries.length) break;
        for (const child of entries) {
          const parent = String(basePath || entry.fullPath || entry.name).replace(/\\/g, '/').replace(/^\/+/, '');
          const childPath = (parent ? parent + '/' : '') + child.name;
          const childFiles = await readEntryAsFiles(child, childPath);
          collected.push.apply(collected, childFiles);
        }
      }
      return collected;
    }
    return [];
  }

  async function collectDroppedFiles(dataTransfer) {
    const items = Array.prototype.slice.call(dataTransfer.items || []);
    const entries = items.map(function (item) { return item.webkitGetAsEntry ? item.webkitGetAsEntry() : null; }).filter(Boolean);
    if (!entries.length) return Array.prototype.slice.call(dataTransfer.files || []);

    const records = [];
    for (const entry of entries) {
      const entryRecords = await readEntryAsFiles(entry, entry.fullPath || entry.name);
      records.push.apply(records, entryRecords);
    }
    return records.map(function (record) {
      try { if (!record.file.webkitRelativePath) Object.defineProperty(record.file, 'webkitRelativePath', { value: record.path, configurable: true }); }
      catch (error) { record.file.__deboogerPath = record.path; }
      return record.file;
    });
  }

  window.DeboogerLoader = { MAX_TEXT_FILE, loadProjectFiles, collectDroppedFiles, detectProject, mimeFromPath };
})();

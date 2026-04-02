/**
 * scanner.js
 * Orchestrates the camera stream, image capture, Tesseract OCR, and UI transitions.
 */

'use strict';

(function () {

  /* ── DOM references ── */
  const $ = id => document.getElementById(id);

  const screens = {
    start:      $('screen-start'),
    camera:     $('screen-camera'),
    processing: $('screen-processing'),
    results:    $('screen-results'),
    error:      $('screen-error'),
  };

  const video          = $('camera-video');
  const captureCanvas  = $('capture-canvas');
  const resultThumb    = $('result-thumb');
  const cameraHint     = $('camera-hint');
  const progressBar    = $('progress-bar');
  const processingTitle = $('processing-title');
  const processingDetail = $('processing-detail');
  const resultFields   = $('result-fields');
  const mrzRaw         = $('mrz-raw');
  const resultTitle    = $('result-title');
  const resultSubtitle = $('result-subtitle');
  const errorTitle     = $('error-title');
  const errorMessage   = $('error-message');
  const toast          = $('toast');

  /* ── State ── */
  let stream = null;
  let lastCapturedDataURL = null;
  let toastTimer = null;
  let tesseractWorker = null;

  /* ── Screen navigation ── */
  function showScreen(name) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[name].classList.add('active');
  }

  /* ── Toast ── */
  function showToast(msg, duration = 2800) {
    if (toastTimer) clearTimeout(toastTimer);
    toast.textContent = msg;
    toast.classList.add('show');
    toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
  }

  /* ── Progress ── */
  function setProgress(pct, detail = '') {
    progressBar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    processingDetail.textContent = detail;
  }

  /* ── Camera ── */
  async function startCamera() {
    stopCamera();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width:  { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      showScreen('camera');
      cameraHint.textContent = 'Align the passport within the frame';
    } catch (err) {
      handleCameraError(err);
    }
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
      video.srcObject = null;
    }
  }

  function handleCameraError(err) {
    console.error('Camera error:', err);
    let msg = 'Camera access failed.';
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      msg = 'Camera permission denied. Please allow camera access in your browser settings, then try again.';
    } else if (err.name === 'NotFoundError') {
      msg = 'No camera found on this device.';
    } else if (err.name === 'NotReadableError') {
      msg = 'Camera is already in use by another application.';
    }
    showErrorScreen('Camera Unavailable', msg);
  }

  /* ── Capture frame from video ── */
  function captureVideoFrame() {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) throw new Error('Video dimensions unavailable');

    captureCanvas.width  = vw;
    captureCanvas.height = vh;
    const ctx = captureCanvas.getContext('2d');
    ctx.drawImage(video, 0, 0, vw, vh);
    return captureCanvas.toDataURL('image/jpeg', 0.92);
  }

  /* ── Image preprocessing ── */

  function prepareCanvas(img, yFrac, hFrac) {
    const W = img.width, H = img.height;
    const cropY = Math.round(H * yFrac);
    const cropH = Math.round(H * hFrac);
    const scale = Math.max(1, 1400 / W);
    const outW = Math.round(W * scale);
    const outH = Math.round(cropH * scale);
    const canvas = document.createElement('canvas');
    canvas.width = outW; canvas.height = outH;
    const ctx = canvas.getContext('2d');
    ctx.filter = 'grayscale(1) contrast(2.2) brightness(1.05)';
    ctx.drawImage(img, 0, cropY, W, cropH, 0, 0, outW, outH);
    ctx.filter = 'none';
    return canvas;
  }

  function binarizeCanvas(src, threshold) {
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0);
    const id = ctx.getImageData(0, 0, c.width, c.height);
    const d = id.data;
    // Adaptive: use mean luminance if threshold not specified
    if (threshold == null) {
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i];
      threshold = Math.min((sum / (d.length / 4)) * 0.85, 175);
    }
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i] < threshold ? 0 : 255;
      d[i] = d[i+1] = d[i+2] = v;
    }
    ctx.putImageData(id, 0, 0);
    return c;
  }

  function invertCanvas(src) {
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const ctx = c.getContext('2d');
    ctx.filter = 'invert(1)';
    ctx.drawImage(src, 0, 0);
    return c;
  }

  /**
   * Build preprocessed image candidates targeting the zone where MRZ sits.
   * When held in hand: MRZ is ~45–80% from top of frame.
   * When flat on desk: MRZ is ~70–95% from top.
   */
  function buildOCRCandidates(dataURL) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const regions = [
          [0.45, 0.35],   // 45–80%  held in hand (most common)
          [0.55, 0.30],   // 55–85%
          [0.60, 0.28],   // 60–88%
          [0.65, 0.25],   // 65–90%  held higher
          [0.70, 0.22],   // 70–92%  flat on desk
          [0.75, 0.25],   // 75–100% flat, passport low in frame
        ];
        const out = [];
        for (const [y, h] of regions) {
          const base    = prepareCanvas(img, y, h);
          const binAuto = binarizeCanvas(base, null);
          const inverted = invertCanvas(binAuto);
          out.push(
            base.toDataURL('image/png'),
            binAuto.toDataURL('image/png'),
            inverted.toDataURL('image/png'),
          );
        }
        resolve(out);
      };
      img.src = dataURL;
    });
  }

  /* ── Tesseract worker ── */
  async function initTesseract() {
    if (tesseractWorker) return tesseractWorker;
    processingDetail.textContent = 'Loading OCR engine…';

    tesseractWorker = await Tesseract.createWorker('eng', 1, {
      logger: m => {
        if (m.status === 'recognizing text') {
          setProgress(40 + m.progress * 40, 'Reading MRZ characters…');
        }
        if (m.status === 'loading tesseract core')          setProgress(10, 'Loading OCR engine…');
        if (m.status === 'initializing tesseract')          setProgress(20, 'Initialising…');
        if (m.status === 'loading language traineddata')    setProgress(30, 'Loading language data…');
      },
    });

    return tesseractWorker;
  }

  /* ── Run OCR on one image ── */
  async function runOCROnImage(worker, imageDataURL, psm, useWhitelist) {
    const params = {
      tessedit_pageseg_mode: String(psm),
      preserve_interword_spaces: '0',
    };
    if (useWhitelist) {
      params.tessedit_char_whitelist = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<';
    } else {
      params.tessedit_char_whitelist = '';
    }
    await worker.setParameters(params);
    const { data } = await worker.recognize(imageDataURL);
    return data.text;
  }

  /* ── Main OCR pipeline: try all candidates until MRZ found ── */
  async function runOCR(dataURL) {
    const worker = await initTesseract();
    const candidates = await buildOCRCandidates(dataURL);
    let lastText = '';

    // Priority attempts: PSM 11 (sparse) without whitelist first — most permissive
    for (const img of candidates) {
      const text = await runOCROnImage(worker, img, 11, false);
      lastText = text;
      const lines = MRZParser.extractMRZLines(text);
      if (lines) return { text, lines };
    }

    // Second pass: PSM 6 (uniform block) with whitelist
    for (const img of candidates) {
      const text = await runOCROnImage(worker, img, 6, true);
      lastText = text;
      const lines = MRZParser.extractMRZLines(text);
      if (lines) return { text, lines };
    }

    return { text: lastText, lines: null };
  }

  /* ── Main scan pipeline ── */
  async function scanImage(dataURL) {
    stopCamera();
    showScreen('processing');
    setProgress(5, 'Preparing image…');
    processingTitle.textContent = 'Analysing passport…';

    // Render thumbnail
    await renderThumbnail(dataURL);

    try {
      setProgress(8, 'Preparing image crops…');

      setProgress(12, 'Starting OCR engine…');
      const { text: ocrText, lines: mrzLines } = await runOCR(dataURL);

      setProgress(90, 'Parsing MRZ data…');
      const { data, lines, error } = mrzLines
        ? { data: MRZParser.parseLines(mrzLines[0], mrzLines[1]), lines: mrzLines, error: null }
        : MRZParser.parseFromOCR(ocrText);

      setProgress(100, 'Done');

      if (!data || (!data.surname && !data.passportNumber)) {
        showErrorScreen(
          'MRZ Not Detected',
          error || 'Could not read the Machine Readable Zone. Ensure the passport is well-lit and fully visible.'
        );
        return;
      }

      setTimeout(() => showResultsScreen(data, lines), 300);

    } catch (err) {
      console.error('Scan error:', err);
      showErrorScreen('Scan Failed', err.message || 'An unexpected error occurred. Please try again.');
    }
  }

  /* ── Thumbnail rendering ── */
  function renderThumbnail(dataURL) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const maxW = 480;
        const scale = Math.min(1, maxW / img.width);
        resultThumb.width  = Math.round(img.width  * scale);
        resultThumb.height = Math.round(img.height * scale);
        const ctx = resultThumb.getContext('2d');
        ctx.drawImage(img, 0, 0, resultThumb.width, resultThumb.height);
        resolve();
      };
      img.src = dataURL;
    });
  }

  /* ── Results screen ── */
  function showResultsScreen(data, lines) {
    resultFields.innerHTML = '';

    resultTitle.textContent = data.valid ? 'Passport Read Successfully' : 'Passport Read (with warnings)';
    resultSubtitle.textContent = data.valid
      ? 'All check digits verified'
      : `Warning: ${data.errors.join('; ')}`;

    const statusIcon = $('result-status-icon');
    statusIcon.className = 'result-status-icon ' + (data.valid ? 'result-success' : 'result-warn');

    // Build field cards
    const fields = [];

    if (data.fullName)   fields.push({ label: 'Full Name', value: data.fullName, full: true });
    if (data.surname)    fields.push({ label: 'Surname', value: data.surname });
    if (data.givenNames) fields.push({ label: 'Given Names', value: data.givenNames });

    fields.push({
      label: 'Passport Number',
      value: data.passportNumber || '—',
      mono: true,
      status: data.checkDigits?.passportNumber === false ? 'warn' : 'ok',
    });

    fields.push({
      label: 'Nationality',
      value: data.nationalityName
        ? `${data.nationalityName} (${data.nationality})`
        : data.nationality || '—',
    });

    fields.push({
      label: 'Issuing Country',
      value: data.issuingCountryName
        ? `${data.issuingCountryName} (${data.issuingCountry})`
        : data.issuingCountry || '—',
    });

    if (data.dateOfBirth) {
      fields.push({
        label: 'Date of Birth',
        value: data.dateOfBirth.display,
        status: data.checkDigits?.dateOfBirth === false ? 'warn' : '',
      });
    }

    fields.push({ label: 'Sex', value: data.sex || '—' });

    if (data.expiryDate) {
      fields.push({
        label: 'Expiry Date',
        value: data.expiryDate.display + (data.expired ? ' (EXPIRED)' : ''),
        status: data.expired ? 'warn' : (data.checkDigits?.expiryDate === false ? 'warn' : 'ok'),
      });
    }

    if (data.personalNumber) {
      fields.push({ label: 'Personal Number', value: data.personalNumber, mono: true });
    }

    fields.push({
      label: 'Check Digits',
      value: Object.entries(data.checkDigits || {})
        .map(([k, v]) => v === null ? null : `${k}: ${v ? '✓' : '✗'}`)
        .filter(Boolean).join('  '),
      mono: true,
      full: true,
      status: Object.values(data.checkDigits || {}).some(v => v === false) ? 'warn' : 'ok',
    });

    for (const f of fields) {
      const card = document.createElement('div');
      card.className = 'field-card' +
        (f.full   ? ' field-full'  : '') +
        (f.status === 'warn' ? ' field-warn' : '') +
        (f.status === 'ok'   ? ' field-ok'   : '');

      const lbl = document.createElement('div');
      lbl.className = 'field-label';
      lbl.textContent = f.label;

      const val = document.createElement('div');
      val.className = 'field-value' + (f.mono ? ' mono' : '');
      val.textContent = f.value;

      card.appendChild(lbl);
      card.appendChild(val);
      resultFields.appendChild(card);
    }

    // Raw MRZ
    if (lines) {
      mrzRaw.textContent = lines.join('\n');
    }

    showScreen('results');
  }

  /* ── Error screen ── */
  function showErrorScreen(title, message) {
    errorTitle.textContent   = title;
    errorMessage.textContent = message;
    showScreen('error');
  }

  /* ── File / gallery upload ── */
  function handleFileUpload(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      lastCapturedDataURL = e.target.result;
      scanImage(lastCapturedDataURL);
    };
    reader.readAsDataURL(file);
  }

  /* ── Copy JSON ── */
  function copyResultJSON(data) {
    const exportData = {
      documentType:      data.documentType,
      issuingCountry:    data.issuingCountry,
      surname:           data.surname,
      givenNames:        data.givenNames,
      passportNumber:    data.passportNumber,
      nationality:       data.nationality,
      dateOfBirth:       data.dateOfBirth?.iso,
      sex:               data.sex,
      expiryDate:        data.expiryDate?.iso,
      personalNumber:    data.personalNumber,
      valid:             data.valid,
    };
    const json = JSON.stringify(exportData, null, 2);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(json)
        .then(() => showToast('Copied to clipboard'))
        .catch(() => fallbackCopy(json));
    } else {
      fallbackCopy(json);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showToast('Copied to clipboard');
    } catch {
      showToast('Could not copy — please copy manually');
    }
    document.body.removeChild(ta);
  }

  /* ── Event wiring ── */
  $('btn-start-camera').addEventListener('click', startCamera);

  $('btn-cancel-camera').addEventListener('click', () => {
    stopCamera();
    showScreen('start');
  });

  $('btn-capture').addEventListener('click', () => {
    try {
      lastCapturedDataURL = captureVideoFrame();
      scanImage(lastCapturedDataURL);
    } catch (err) {
      showToast('Could not capture frame: ' + err.message);
    }
  });

  $('btn-upload').addEventListener('click', () => {
    $('file-input').click();
  });

  $('file-input').addEventListener('change', e => {
    handleFileUpload(e.target.files[0]);
    e.target.value = '';
  });

  $('btn-scan-again').addEventListener('click', () => startCamera());

  $('btn-retry').addEventListener('click', () => startCamera());

  $('btn-copy-json').addEventListener('click', () => {
    // Rebuild data from current MRZ raw display
    const raw = mrzRaw.textContent.trim();
    const lines = raw.split('\n');
    if (lines.length >= 2) {
      const parsed = MRZParser.parseLines(lines[0], lines[1]);
      copyResultJSON(parsed);
    } else {
      showToast('No data to copy');
    }
  });

  /* ── Cleanup on page hide (mobile background) ── */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopCamera();
  });

  /* ── Check browser support ── */
  function checkSupport() {
    if (!navigator.mediaDevices?.getUserMedia) {
      const note = document.querySelector('.privacy-note');
      if (note) {
        note.textContent = '⚠ Camera API not available. You can still upload an image using the gallery button after opening the scanner.';
        note.style.color = '#f59e0b';
      }
    }
  }

  checkSupport();

})();

import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.worker.min.mjs';

const PDF_URL = './Wsheet.pdf';

// Wsheet.pdf holds imposed landscape sheets — each PDF page is really two
// A5 pages side by side. This is the core brochure, in reading order, and
// says which half of which PDF page each logical page comes from. Edit
// this if your core imposition differs.
//
// If a PDF page is already a single, un-imposed A5 page (no cropping
// needed), use half: null for that entry instead. Any PDF page you don't
// explicitly reference here (including unused halves, like the blank
// right half of page 3) is assumed by init() to be a later un-imposed
// insert — so if you add more imposed sheets after this map, list both
// halves you actually want here rather than relying on auto-append.
const BASE_PAGE_MAP = [
    { pdfPage: 1, half: 'right' }, // Logical page 1 - Front Cover
    { pdfPage: 2, half: 'left' },  // Logical page 2 - Inside Left
    { pdfPage: 2, half: 'right' }, // Logical page 3 - Inside Right
    { pdfPage: 1, half: 'left' },  // Logical page 4 - Back Cover
    { pdfPage: 3, half: 'left' },  // Logical page 5 - Psalm 23 insert
    // Right half of PDF page 3 is blank in the source file, so it's
    // intentionally not mapped to a logical page.
];

// The actual page map used at runtime. This starts as BASE_PAGE_MAP, but
// init() appends any extra PDF pages found after the ones BASE_PAGE_MAP
// already uses, as plain full A5 pages, so extra inserts/sheets after
// page 4 just work without editing this file.
let PAGE_MAP = BASE_PAGE_MAP.slice();

const pdfPageCache = new Map();
async function getPdfPage(pdfPageNumber) {
    if (!pdfPageCache.has(pdfPageNumber)) {
        pdfPageCache.set(pdfPageNumber, pdfDoc.getPage(pdfPageNumber));
    }
    return pdfPageCache.get(pdfPageNumber);
}

let pdfDoc = null;
let totalPages = 0;
let currentPage = 1;
let busy = false;
let pendingTarget = null;
let resizeTimer = null;

const frame = document.getElementById('pageFrame');
const leafBaseCanvas = document.getElementById('leafBaseCanvas');
const leafFlip = document.getElementById('leafFlip');
const leafFlipCanvas = document.getElementById('leafFlipCanvas');
const pipsRow = document.getElementById('pipsRow');
const btnBack = document.getElementById('btnBack');
const btnFwd = document.getElementById('btnFwd');
const pageLabel = document.getElementById('pageLabel');
const progressFill = document.getElementById('progressFill');

let pipEls = [];

function setPageRatio(width, height) {
    if (width > 0 && height > 0) {
        document.documentElement.style.setProperty('--page-ratio', String(width / height));
    }
}

function updateUI() {
    if (!totalPages) return;

    pageLabel.textContent = `Page ${currentPage} of ${totalPages}`;
    btnBack.disabled = currentPage === 1;
    btnFwd.disabled = currentPage === totalPages;
    frame.className = `page-frame ${currentPage % 2 === 0 ? 'left-page' : 'right-page'}`;
    pipEls.forEach((pip, index) => pip.classList.toggle('active', index + 1 === currentPage));
    progressFill.style.width = `${(currentPage / totalPages) * 100}%`;
}

function buildNavigationDots() {
    pipsRow.replaceChildren();
    pipEls = [];

    const fragment = document.createDocumentFragment();
    const midpoint = totalPages > 1 ? Math.ceil(totalPages / 2) : 0;

    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
        const pip = document.createElement('button');
        pip.type = 'button';
        pip.className = 'pip';
        pip.id = `pip${pageNumber - 1}`;
        pip.title = `Page ${pageNumber}`;
        pip.setAttribute('aria-label', `Go to page ${pageNumber}`);
        pip.addEventListener('click', () => jumpTo(pageNumber));
        fragment.appendChild(pip);
        pipEls.push(pip);

        if (pageNumber === midpoint && pageNumber !== totalPages) {
            const divider = document.createElement('div');
            divider.className = 'pip-divider';
            fragment.appendChild(divider);
        }
    }

    pipsRow.appendChild(fragment);
}

async function renderPage(logicalPageNumber, canvas) {
    const mapping = PAGE_MAP[logicalPageNumber - 1];
    if (!mapping) return;

    // Guard against a slower, older render finishing after a newer one.
    const myGen = (canvas._renderGen || 0) + 1;
    canvas._renderGen = myGen;

    const page = await getPdfPage(mapping.pdfPage);
    const frameWidth = frame.clientWidth;
    const frameHeight = frame.clientHeight;
    const baseViewport = page.getViewport({ scale: 1 });
    const contentWidth = mapping.half ? baseViewport.width / 2 : baseViewport.width;
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.min(frameWidth / contentWidth, frameHeight / baseViewport.height) * dpr;
    const viewport = page.getViewport({ scale });

    if (!mapping.half) {
        // The PDF page already IS one A5 page — render it straight in, no cropping.
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) {
            throw new Error('Unable to create canvas context');
        }

        if (canvas._renderTask) {
            try {
                canvas._renderTask.cancel();
            } catch {
                /* ignored */
            }
        }

        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        canvas.style.width = `${Math.max(1, Math.ceil(viewport.width / dpr))}px`;
        canvas.style.height = `${Math.max(1, Math.ceil(viewport.height / dpr))}px`;

        const renderTask = page.render({ canvasContext: context, viewport });
        canvas._renderTask = renderTask;

        try {
            await renderTask.promise;
        } finally {
            if (canvas._renderTask === renderTask) {
                canvas._renderTask = null;
            }
        }
        return;
    }

    // Sheet holds two A5 pages side by side — render the whole sheet to an
    // offscreen canvas first...
    const offscreen = document.createElement('canvas');
    offscreen.width = Math.max(1, Math.ceil(viewport.width));
    offscreen.height = Math.max(1, Math.ceil(viewport.height));
    const offCtx = offscreen.getContext('2d', { alpha: false });

    if (!offCtx) {
        throw new Error('Unable to create canvas context');
    }

    await page.render({ canvasContext: offCtx, viewport }).promise;

    if (canvas._renderGen !== myGen) return; // superseded by a newer render

    // ...then crop out just the requested A5 half.
    const halfPxWidth = offscreen.width / 2;
    const sx = mapping.half === 'left' ? 0 : halfPxWidth;

    const context = canvas.getContext('2d', { alpha: false });
    if (!context) {
        throw new Error('Unable to create canvas context');
    }

    canvas.width = Math.max(1, Math.ceil(halfPxWidth));
    canvas.height = offscreen.height;
    canvas.style.width = `${Math.max(1, Math.ceil(halfPxWidth / dpr))}px`;
    canvas.style.height = `${Math.max(1, Math.ceil(offscreen.height / dpr))}px`;

    context.drawImage(
        offscreen,
        sx, 0, halfPxWidth, offscreen.height,
        0, 0, halfPxWidth, offscreen.height,
    );
}

async function renderCurrentPage() {
    if (!pdfDoc) return;
    await renderPage(currentPage, leafBaseCanvas);
    updateUI();
}

function scheduleRerender() {
    if (!pdfDoc) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        if (busy) return;
        void renderCurrentPage();
    }, 120);
}

function onFlipEnd() {
    leafFlip.removeEventListener('animationend', onFlipEnd);
    leafFlip.classList.remove('flip-fwd', 'flip-back');
    leafFlip.style.display = 'none';
    busy = false;
    updateUI();

    if (pendingTarget !== null && pendingTarget !== currentPage) {
        const target = pendingTarget;
        pendingTarget = null;
        go(target > currentPage ? 1 : -1);
        return;
    }

    pendingTarget = null;
}

async function go(dir) {
    if (busy || dir === 0 || !pdfDoc) return;

    const nextPage = currentPage + dir;
    if (nextPage < 1 || nextPage > totalPages) return;

    busy = true;
    const fromPage = currentPage;
    currentPage = nextPage;

    try {
        await Promise.all([
            renderPage(fromPage, leafFlipCanvas),
            renderPage(nextPage, leafBaseCanvas),
        ]);
    } catch (error) {
        console.error(error);
        busy = false;
        currentPage = fromPage;
        updateUI();
        return;
    }

    leafFlip.style.display = 'block';
    leafFlip.classList.remove('flip-fwd', 'flip-back');
    void leafFlip.offsetWidth;
    leafFlip.classList.add(dir > 0 ? 'flip-fwd' : 'flip-back');
    leafFlip.addEventListener('animationend', onFlipEnd);
}

function jumpTo(pageNumber) {
    if (!totalPages || pageNumber < 1 || pageNumber > totalPages) return;
    if (pageNumber === currentPage && pendingTarget === null) return;

    pendingTarget = pageNumber;
    if (!busy) {
        go(pageNumber > currentPage ? 1 : -1);
    }
}

btnBack.addEventListener('click', () => go(-1));
btnFwd.addEventListener('click', () => go(1));

document.addEventListener('keydown', event => {
    if (event.key === 'ArrowRight') go(1);
    if (event.key === 'ArrowLeft') go(-1);
});

window.addEventListener('resize', scheduleRerender);

async function init() {
    try {
        pdfDoc = await pdfjsLib.getDocument(PDF_URL).promise;

        // Extend PAGE_MAP with any PDF pages beyond the ones BASE_PAGE_MAP
        // already references, so extra A5 pages/inserts after page 4 show
        // up automatically as plain full pages.
        const highestUsedPdfPage = Math.max(...BASE_PAGE_MAP.map(m => m.pdfPage));
        const extraPages = [];
        for (let p = highestUsedPdfPage + 1; p <= pdfDoc.numPages; p += 1) {
            extraPages.push({ pdfPage: p, half: null });
        }
        PAGE_MAP = [...BASE_PAGE_MAP, ...extraPages];

        if (extraPages.length > 0) {
            console.info(`Found ${extraPages.length} extra A5 page(s) after page ${BASE_PAGE_MAP.length}.`);
        }

        totalPages = PAGE_MAP.length;

        const firstMapping = PAGE_MAP[0];
        const firstPage = await getPdfPage(firstMapping.pdfPage);
        const firstViewport = firstPage.getViewport({ scale: 1 });
        const firstWidth = firstMapping.half ? firstViewport.width / 2 : firstViewport.width;
        setPageRatio(firstWidth, firstViewport.height);

        buildNavigationDots();
        currentPage = 1;
        await renderCurrentPage();
    } catch (error) {
        console.error(error);
        pageLabel.textContent = 'Unable to load Wsheet.pdf';
        btnBack.disabled = true;
        btnFwd.disabled = true;
    }
}

void init();

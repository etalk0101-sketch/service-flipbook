import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.worker.min.mjs';

const PDF_URL = './Wsheet.pdf';

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

async function renderPage(pageNumber, canvas) {
    const page = await pdfDoc.getPage(pageNumber);
    const frameWidth = frame.clientWidth;
    const frameHeight = frame.clientHeight;
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(frameWidth / baseViewport.width, frameHeight / baseViewport.height);
    const dpr = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: scale * dpr });
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

let touchStartX = 0;
document.addEventListener('touchstart', event => {
    touchStartX = event.touches[0].clientX;
}, { passive: true });
document.addEventListener('touchend', event => {
    const deltaX = event.changedTouches[0].clientX - touchStartX;
    if (Math.abs(deltaX) > 38) {
        go(deltaX < 0 ? 1 : -1);
    }
}, { passive: true });

window.addEventListener('resize', scheduleRerender);

async function init() {
    try {
        pdfDoc = await pdfjsLib.getDocument(PDF_URL).promise;
        totalPages = pdfDoc.numPages;

        const firstPage = await pdfDoc.getPage(1);
        const firstViewport = firstPage.getViewport({ scale: 1 });
        setPageRatio(firstViewport.width, firstViewport.height);

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
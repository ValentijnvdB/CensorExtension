

// ── Blur ────────────────────────────────────────────────────────

const BLUR_STRENGTH = 30;


function applyBlur(img) {
    img.style.filter=`blur(${BLUR_STRENGTH}px)`
}


function reverseBlur(img) {
    img.style.filter=""
}


// ── Pixelate ────────────────────────────────────────────────────────

const PIXELATE_STRENGTH = 20;

function applyPixelate(img) {
    if (img.complete && img.naturalWidth > 0) {
        pixelateImage(img, PIXELATE_STRENGTH);
    } else {
        img.addEventListener('load', () => pixelateImage(img, PIXELATE_STRENGTH), { once: true });
    }
}

function reversePixelate(img) {
}

function pixelateImage(originalImage, pixelationFactor) {
    if (isOwnAsset(originalImage)) return;

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    const originalWidth = originalImage.width;
    const originalHeight = originalImage.height;

    canvas.width = originalWidth;
    canvas.height = originalHeight;

    context.drawImage(originalImage, 0, 0, originalWidth, originalHeight);

    const originalImageData = context.getImageData(
        0,
        0,
        originalWidth,
        originalHeight
    ).data;

    if (pixelationFactor !== 0) {
        for (let y = 0; y < originalHeight; y += pixelationFactor) {
            for (let x = 0; x < originalWidth; x += pixelationFactor) {
                // extracting the position of the sample pixel
                const pixelIndexPosition = (x + y * originalWidth) * 4;

                // drawing a square replacing the current pixels
                context.fillStyle = `rgba(
                  ${originalImageData[pixelIndexPosition]},
                  ${originalImageData[pixelIndexPosition + 1]},
                  ${originalImageData[pixelIndexPosition + 2]},
                  ${originalImageData[pixelIndexPosition + 3]}
                )`;
                context.fillRect(x, y, pixelationFactor, pixelationFactor);
            }
        }
    }
    setSrc(originalImage, canvas.toDataURL());
}


// ── Main functions ────────────────────────────────────────────────────────

function applyLoadBehavior(img) {
    if (settings.loadBehavior === 'blur') {
        applyBlur(img);
    } else if (settings.loadBehavior === 'pixelate') {
        applyPixelate(img);
    } else {
        setSrc(img, browser.runtime.getURL("assets/loading.png"))
    }
}

function reverseLoadBehavior(img) {
    if (settings.loadBehavior === 'blur') {
        reverseBlur(img);
    } else if (settings.loadBehavior === 'pixelate') {
        reversePixelate(img);
    }
}
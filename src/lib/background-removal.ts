"use client";

import { removeBackground as rembgRemoveBackground, subscribeToProgress, getCapabilities } from 'rembg-webgpu';

export interface BackgroundRemovalResult {
  blobUrl: string;
  base64: string;
  width: number;
  height: number;
  processingTimeSeconds: number;
}

export interface ProgressState {
  phase: 'idle' | 'downloading' | 'building' | 'processing' | 'ready' | 'error';
  progress: number;
  errorMsg?: string;
}

export { subscribeToProgress, getCapabilities };

// Maximum image dimension for mobile devices to prevent memory crashes
const MOBILE_MAX_DIMENSION = 1024;

/**
 * Detect if the current device is mobile
 */
function isMobileDevice(): boolean {
  if (typeof window === 'undefined') return false;

  // Check for mobile user agent
  const userAgent = navigator.userAgent.toLowerCase();
  const isMobileUA = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(userAgent);

  // Also check screen size as a fallback
  const isSmallScreen = window.innerWidth <= 768;

  return isMobileUA || isSmallScreen;
}

/**
 * Resize an image if it exceeds the maximum dimension (for mobile memory management)
 */
async function resizeImageIfNeeded(imageUrl: string, maxDimension: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      const { width, height } = img;

      // Check if resizing is needed
      if (width <= maxDimension && height <= maxDimension) {
        resolve(imageUrl); // Return original if small enough
        return;
      }

      // Calculate new dimensions maintaining aspect ratio
      let newWidth: number;
      let newHeight: number;

      if (width > height) {
        newWidth = maxDimension;
        newHeight = Math.round((height / width) * maxDimension);
      } else {
        newHeight = maxDimension;
        newWidth = Math.round((width / height) * maxDimension);
      }

      // Create canvas and resize
      const canvas = document.createElement('canvas');
      canvas.width = newWidth;
      canvas.height = newHeight;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Could not get canvas context'));
        return;
      }

      // Use high-quality image smoothing
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, newWidth, newHeight);

      // Return as data URL
      resolve(canvas.toDataURL('image/png'));
    };

    img.onerror = () => reject(new Error('Failed to load image for resizing'));
    img.src = imageUrl;
  });
}

/**
 * Convert a data URL or any URL to a blob URL that rembg can process
 */
async function ensureBlobUrl(imageUrl: string): Promise<string> {
  // If it's already a blob URL, return as-is
  if (imageUrl.startsWith('blob:')) {
    return imageUrl;
  }
  
  // For data URLs and other URLs, convert to blob first
  try {
    const response = await fetch(imageUrl);
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  } catch (err) {
    throw new Error(`Failed to convert image to blob: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }
}

/**
 * Remove background from an image using AI (runs entirely in browser via WebGPU/WASM)
 */
export async function removeImageBackground(
  imageUrl: string,
  onProgress?: (state: ProgressState) => void
): Promise<BackgroundRemovalResult> {
  // Set up progress tracking if callback provided
  let unsubscribe: (() => void) | undefined;
  if (onProgress) {
    unsubscribe = subscribeToProgress((state) => {
      onProgress({
        phase: state.phase as ProgressState['phase'],
        progress: state.progress,
        errorMsg: state.errorMsg,
      });
    });
  }

  let processBlobUrl: string | null = null;

  try {
    // Signal processing start
    onProgress?.({ phase: 'processing', progress: 0 });

    // Convert image URL to blob URL for rembg
    console.log('[Background Removal] Converting image URL to blob...');
    processBlobUrl = await ensureBlobUrl(imageUrl);

    // On mobile, resize the image first to prevent memory crashes
    let processImageUrl = processBlobUrl;
    if (isMobileDevice()) {
      console.log('[Background Removal] Mobile device detected, resizing image...');
      processImageUrl = await resizeImageIfNeeded(processBlobUrl, MOBILE_MAX_DIMENSION);
    }

    console.log('[Background Removal] Starting removal...');
    let result;
    try {
      result = await rembgRemoveBackground(processImageUrl);
    } catch (rembgError) {
      console.error('[Background Removal] rembg error:', rembgError);
      throw new Error(`rembg failed: ${rembgError instanceof Error ? rembgError.message : 'Unknown error'}`);
    }

    // Check if result has valid blobUrl
    if (!result) {
      throw new Error('Background removal failed - no result returned');
    }
    if (!result.blobUrl) {
      throw new Error('Background removal failed - no blob URL in result');
    }

    // Convert blob URL to base64 for storage/API compatibility
    // Use XMLHttpRequest as fallback since fetch may fail for blob URLs in some contexts
    let base64: string;
    try {
      const response = await fetch(result.blobUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch result: ${response.status}`);
      }
      const blob = await response.blob();
      base64 = await blobToBase64(blob);
    } catch (fetchError) {
      // Try XMLHttpRequest as fallback
      console.log('[Background Removal] Fetch failed, trying XMLHttpRequest fallback');
      base64 = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', result.blobUrl!, true);
        xhr.responseType = 'blob';
        xhr.onload = () => {
          if (xhr.status === 200) {
            blobToBase64(xhr.response).then(resolve).catch(reject);
          } else {
            reject(new Error(`XHR failed: ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(new Error('XHR network error'));
        xhr.send();
      });
    }

    onProgress?.({ phase: 'ready', progress: 100 });

    return {
      blobUrl: result.blobUrl,
      base64,
      width: result.width || 0,
      height: result.height || 0,
      processingTimeSeconds: result.processingTimeSeconds || 0,
    };
  } finally {
    unsubscribe?.();
    // Clean up the temporary blob URL we created
    if (processBlobUrl && processBlobUrl.startsWith('blob:') && processBlobUrl !== imageUrl) {
      URL.revokeObjectURL(processBlobUrl);
    }
  }
}

/**
 * Convert a Blob to base64 string (without data URL prefix)
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      // Remove the data URL prefix (e.g., "data:image/png;base64,")
      const base64 = dataUrl.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Check if background removal is supported on this device
 */
export async function checkBackgroundRemovalSupport(): Promise<{
  supported: boolean;
  device: 'webgpu' | 'wasm';
  dtype: 'fp16' | 'fp32';
}> {
  try {
    const capabilities = await getCapabilities();
    return {
      supported: true,
      device: capabilities.device as 'webgpu' | 'wasm',
      dtype: capabilities.dtype as 'fp16' | 'fp32',
    };
  } catch {
    return {
      supported: false,
      device: 'wasm',
      dtype: 'fp32',
    };
  }
}

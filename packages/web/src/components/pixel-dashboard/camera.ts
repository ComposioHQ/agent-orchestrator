import type { PixelWorldModel, SceneRect } from "./scene-model";

export interface CameraViewport {
  height: number;
  width: number;
}

export interface CameraState {
  x: number;
  y: number;
  zoom: number;
}

export interface CameraBounds {
  maxX: number;
  maxY: number;
  minX: number;
  minY: number;
}

const DEFAULT_FRAME_PADDING = 32;
export const MIN_CAMERA_ZOOM = 0.65;
export const MAX_CAMERA_ZOOM = 1.6;

export function clampZoom(zoom: number): number {
  return clampNumber(zoom, MIN_CAMERA_ZOOM, MAX_CAMERA_ZOOM);
}

export function getWorldRect(world: Pick<PixelWorldModel, "width" | "height">): SceneRect {
  return {
    x: 0,
    y: 0,
    width: world.width,
    height: world.height,
  };
}

export function createInitialCameraState(
  world: Pick<PixelWorldModel, "width" | "height">,
  viewport: CameraViewport,
  framePadding = DEFAULT_FRAME_PADDING,
): CameraState {
  const safeWidth = Math.max(viewport.width, 1);
  const safeHeight = Math.max(viewport.height, 1);
  const horizontalFit = (safeWidth - framePadding * 2) / Math.max(world.width, 1);
  const verticalFit = (safeHeight - framePadding * 2) / Math.max(world.height, 1);
  const zoom = clampZoom(Math.min(horizontalFit, verticalFit, 1.15));

  return clampCameraPosition(
    {
      x: (safeWidth - world.width * zoom) / 2,
      y: (safeHeight - world.height * zoom) / 2,
      zoom,
    },
    world,
    viewport,
  );
}

export function getCameraBounds(
  world: Pick<PixelWorldModel, "width" | "height">,
  viewport: CameraViewport,
  zoom: number,
): CameraBounds {
  const scaledWidth = world.width * zoom;
  const scaledHeight = world.height * zoom;

  const xBounds =
    scaledWidth <= viewport.width
      ? {
          min: (viewport.width - scaledWidth) / 2,
          max: (viewport.width - scaledWidth) / 2,
        }
      : {
          min: viewport.width - scaledWidth,
          max: 0,
        };
  const yBounds =
    scaledHeight <= viewport.height
      ? {
          min: (viewport.height - scaledHeight) / 2,
          max: (viewport.height - scaledHeight) / 2,
        }
      : {
          min: viewport.height - scaledHeight,
          max: 0,
        };

  return {
    minX: xBounds.min,
    maxX: xBounds.max,
    minY: yBounds.min,
    maxY: yBounds.max,
  };
}

export function clampCameraPosition(
  camera: CameraState,
  world: Pick<PixelWorldModel, "width" | "height">,
  viewport: CameraViewport,
): CameraState {
  const zoom = clampZoom(camera.zoom);
  const bounds = getCameraBounds(world, viewport, zoom);

  return {
    x: clampNumber(camera.x, bounds.minX, bounds.maxX),
    y: clampNumber(camera.y, bounds.minY, bounds.maxY),
    zoom,
  };
}

export function panCamera(
  camera: CameraState,
  delta: Pick<CameraState, "x" | "y">,
  world: Pick<PixelWorldModel, "width" | "height">,
  viewport: CameraViewport,
): CameraState {
  return clampCameraPosition(
    {
      ...camera,
      x: camera.x + delta.x,
      y: camera.y + delta.y,
    },
    world,
    viewport,
  );
}

export function zoomCameraAtPoint(
  camera: CameraState,
  nextZoom: number,
  anchor: {
    x: number;
    y: number;
  },
  world: Pick<PixelWorldModel, "width" | "height">,
  viewport: CameraViewport,
): CameraState {
  const zoom = clampZoom(nextZoom);
  const worldX = (anchor.x - camera.x) / camera.zoom;
  const worldY = (anchor.y - camera.y) / camera.zoom;

  return clampCameraPosition(
    {
      x: anchor.x - worldX * zoom,
      y: anchor.y - worldY * zoom,
      zoom,
    },
    world,
    viewport,
  );
}

export function getVisibleWorldRect(
  camera: CameraState,
  viewport: CameraViewport,
  world: Pick<PixelWorldModel, "width" | "height">,
): SceneRect {
  const left = clampNumber(-camera.x / camera.zoom, 0, world.width);
  const top = clampNumber(-camera.y / camera.zoom, 0, world.height);
  const width = Math.min(viewport.width / camera.zoom, world.width);
  const height = Math.min(viewport.height / camera.zoom, world.height);

  return {
    x: left,
    y: top,
    width,
    height,
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

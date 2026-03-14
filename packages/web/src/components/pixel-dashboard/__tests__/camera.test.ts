import { describe, expect, it } from "vitest";
import {
  clampCameraPosition,
  clampZoom,
  createInitialCameraState,
  getVisibleWorldRect,
  panCamera,
  zoomCameraAtPoint,
} from "../camera";

const viewport = { width: 900, height: 560 };
const world = { width: 1088, height: 508 };

describe("camera helpers", () => {
  it("frames the world inside the viewport by default", () => {
    const camera = createInitialCameraState(world, viewport);

    expect(camera.zoom).toBeGreaterThanOrEqual(0.65);
    expect(camera.zoom).toBeLessThanOrEqual(1.15);

    const visible = getVisibleWorldRect(camera, viewport, world);
    expect(visible.width).toBeGreaterThanOrEqual(world.width - 4);
    expect(visible.height).toBeGreaterThanOrEqual(world.height - 4);
  });

  it("clamps pan so the operator cannot lose the world", () => {
    const camera = clampCameraPosition({ x: 0, y: 0, zoom: 1.2 }, world, viewport);
    const panned = panCamera(camera, { x: -2000, y: 1200 }, world, viewport);

    expect(panned.x).toBe(viewport.width - world.width * camera.zoom);
    expect(panned.y).toBe(0);
  });

  it("keeps the zoom anchor stable while enforcing bounds", () => {
    const camera = createInitialCameraState(world, viewport);
    const zoomed = zoomCameraAtPoint(camera, 1.35, { x: 450, y: 280 }, world, viewport);

    expect(clampZoom(5)).toBe(1.6);
    expect(clampZoom(0.1)).toBe(0.65);
    expect(zoomed.zoom).toBe(1.35);

    const visible = getVisibleWorldRect(zoomed, viewport, world);
    expect(visible.width).toBeLessThan(viewport.width);
    expect(visible.height).toBeLessThan(viewport.height);
  });
});

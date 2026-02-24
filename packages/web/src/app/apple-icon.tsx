import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "180px",
          height: "180px",
          borderRadius: "36px",
          background: "#0d1117",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
        }}
      >
        <span
          style={{
            color: "#58a6ff",
            fontSize: "80px",
            fontWeight: 700,
            fontFamily: "system-ui, -apple-system, sans-serif",
            letterSpacing: "-2px",
          }}
        >
          ao
        </span>
        <div
          style={{
            position: "absolute",
            top: "38px",
            right: "42px",
            width: "16px",
            height: "16px",
            borderRadius: "50%",
            background: "#3fb950",
            opacity: 0.9,
          }}
        />
      </div>
    ),
    { ...size },
  );
}

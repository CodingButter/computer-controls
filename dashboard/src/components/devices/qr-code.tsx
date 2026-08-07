"use client";

import { useMemo } from "react";
import qrcode from "qrcode-generator";

/**
 * A QR code, drawn as SVG rectangles.
 *
 * SVG rather than a canvas or a PNG data URL because this code is a credential
 * on a screen: it has to survive a phone camera held at an angle in whatever
 * light the room has, and vector modules stay square at any size a card gives
 * them. It also means nothing renders into a bitmap that could be read back
 * out of the page later.
 *
 * Error correction is deliberately low. The correction level trades module
 * density for damage tolerance, and this code lives on a clean screen a foot
 * from the camera for two minutes — there is no damage to tolerate. Level "L"
 * keeps the modules large, which is what actually makes it scan.
 */
export function QrCode(props: { value: string; label: string }) {
  const modules = useMemo(() => {
    // Type version 0 lets the library pick the smallest version that fits.
    const qr = qrcode(0, "L");
    qr.addData(props.value);
    qr.make();
    const count = qr.getModuleCount();
    const dark: [number, number][] = [];
    for (let row = 0; row < count; row += 1) {
      for (let column = 0; column < count; column += 1) {
        if (qr.isDark(row, column)) dark.push([row, column]);
      }
    }
    return { count, dark };
  }, [props.value]);

  // The quiet zone is part of the spec, not padding: a scanner needs four
  // clear modules around the symbol to find its edges at all.
  const quiet = 4;
  const size = modules.count + quiet * 2;

  return (
    <svg
      role="img"
      aria-label={props.label}
      viewBox={`0 0 ${size} ${size}`}
      className="h-56 w-56 rounded-xl"
      shapeRendering="crispEdges"
    >
      {/* Always drawn on white. A QR inverted by a dark theme does not scan. */}
      <rect width={size} height={size} fill="#ffffff" />
      {modules.dark.map(([row, column]) => (
        <rect
          key={`${row}:${column}`}
          x={column + quiet}
          y={row + quiet}
          width={1}
          height={1}
          fill="#000000"
        />
      ))}
    </svg>
  );
}

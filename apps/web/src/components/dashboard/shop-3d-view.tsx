'use client';

import { Float, OrbitControls, RoundedBox } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { Suspense, useMemo, useRef, useState } from 'react';
import type { Mesh } from 'three';

import { GlassCard } from '@/components/ui/glass-card';
import { formatCompact, formatPercent } from '@/lib/utils';
import type { ShopPerformance } from '@/lib/demo-data';

/**
 * Branch performance as a 3D scene.
 *
 * The 3D is the *presentation*, never the only channel: the same numbers are in the
 * table below, which is what a screen reader, a printer and a colleague on a slow
 * laptop actually read. Depth here encodes nothing — height alone carries the value,
 * so the perspective cannot mislead the way a 3D pie chart does.
 *
 * Everything in the scene renders from local geometry and lights. drei's <Environment>
 * and <Text> are deliberately not used: both fetch assets from third-party CDNs at
 * runtime (an HDRI from raw.githack.com, a font index from jsdelivr), which would make
 * the dashboard fail behind a shop firewall, on a poor connection, or whenever someone
 * else's CDN has a bad day. Labels live in the DOM below, where they are also readable
 * by a screen reader and survive printing.
 */

const SERIES_HEX = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'];

interface BarProps {
  position: [number, number, number];
  height: number;
  color: string;
  hovered: boolean;
  onHover: (hovered: boolean) => void;
}

function ShopBar({ position, height, color, hovered, onHover }: BarProps) {
  const meshRef = useRef<Mesh>(null);

  // Grow into place on mount, then hold. A permanently animating bar is unreadable.
  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const target = hovered ? height * 1.04 : height;
    mesh.scale.y += (target - mesh.scale.y) * Math.min(1, delta * 8);
    mesh.position.y = mesh.scale.y / 2;
  });

  return (
    <group position={position}>
      <RoundedBox
        ref={meshRef}
        args={[0.9, 1, 0.9]}
        radius={0.06}
        smoothness={4}
        scale={[1, 0.01, 1]}
        onPointerOver={(event) => {
          event.stopPropagation();
          onHover(true);
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          onHover(false);
          document.body.style.cursor = 'auto';
        }}
      >
        <meshStandardMaterial
          color={color}
          roughness={0.25}
          metalness={0.15}
          emissive={color}
          emissiveIntensity={hovered ? 0.35 : 0.12}
        />
      </RoundedBox>
    </group>
  );
}

function Scene({ shops }: { shops: ShopPerformance[] }) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const maxSales = useMemo(
    () => Math.max(...shops.map((shop) => shop.sales), 1),
    [shops],
  );

  // Centre the row regardless of shop count — this is what lets shop #4 through #40
  // appear without touching the camera.
  const spacing = 1.6;
  const offset = ((shops.length - 1) * spacing) / 2;

  return (
    <>
      {/* Three-point lighting, all local — this replaces the CDN-loaded environment map */}
      <ambientLight intensity={0.75} />
      <directionalLight position={[5, 8, 5]} intensity={1.4} castShadow />
      <pointLight position={[-5, 4, -5]} intensity={0.5} color="#818cf8" />
      <pointLight position={[5, 2, 6]} intensity={0.35} color="#f0abfc" />

      <Float speed={1.2} rotationIntensity={0.08} floatIntensity={0.15}>
        <group position={[0, -0.8, 0]}>
          {shops.map((shop, index) => (
            <ShopBar
              key={shop.id}
              position={[index * spacing - offset, 0, 0]}
              height={Math.max(0.35, (shop.sales / maxSales) * 3.2)}
              color={SERIES_HEX[index % SERIES_HEX.length]!}
              hovered={hoveredIndex === index}
              onHover={(hovered) => setHoveredIndex(hovered ? index : null)}
            />
          ))}

          {/* Ground plane, faint — grounds the bars without drawing attention */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
            <planeGeometry args={[shops.length * spacing + 3, 6]} />
            <meshStandardMaterial color="#1a1a19" transparent opacity={0.35} />
          </mesh>
        </group>
      </Float>

      <OrbitControls
        enablePan={false}
        enableZoom={false}
        minPolarAngle={Math.PI / 4}
        maxPolarAngle={Math.PI / 2.2}
        autoRotate
        autoRotateSpeed={0.4}
      />
    </>
  );
}

export function Shop3DView({ shops }: { shops: ShopPerformance[] }) {
  return (
    <GlassCard padding="md" className="h-full">
      <div className="mb-3">
        <h2 className="text-base font-semibold">Shop performance</h2>
        <p className="text-xs text-[var(--text-muted)]">
          Sales this month · drag to rotate
        </p>
      </div>

      <div className="h-56 w-full overflow-hidden rounded-xl bg-gradient-to-b from-[#12121a] to-[#0a0a0f]">
        <Canvas camera={{ position: [0, 2.2, 6.5], fov: 45 }} dpr={[1, 2]}>
          <Suspense fallback={null}>
            <Scene shops={shops} />
          </Suspense>
        </Canvas>
      </div>

      {/* The accessible, printable, actually-measurable version of the same data */}
      <table className="mt-4 w-full text-sm">
        <caption className="sr-only">Shop performance: sales, profit and target achievement</caption>
        <thead>
          <tr className="border-b border-[var(--glass-ring)] text-left text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
            <th scope="col" className="pb-2 font-medium">Shop</th>
            <th scope="col" className="pb-2 text-right font-medium">Sales</th>
            <th scope="col" className="pb-2 text-right font-medium">Profit</th>
            <th scope="col" className="pb-2 text-right font-medium">Target</th>
          </tr>
        </thead>
        <tbody>
          {shops.map((shop, index) => {
            const achieved = (shop.sales / shop.target) * 100;
            return (
              <tr key={shop.id} className="border-b border-[var(--glass-ring)] last:border-0">
                <td className="py-2">
                  <span className="flex items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-sm"
                      style={{ backgroundColor: SERIES_HEX[index % SERIES_HEX.length] }}
                      aria-hidden
                    />
                    <span className="truncate">{shop.name}</span>
                  </span>
                </td>
                <td className="tabular py-2 text-right">{formatCompact(shop.sales)}</td>
                <td className="tabular py-2 text-right">{formatCompact(shop.profit)}</td>
                <td className="tabular py-2 text-right">
                  <span
                    className={
                      achieved >= 100 ? 'text-[var(--delta-up)]' : 'text-[var(--text-secondary)]'
                    }
                  >
                    {formatPercent(achieved, 0)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </GlassCard>
  );
}

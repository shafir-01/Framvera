import { Component, lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import type { EvidenceTrailProps, ForgeProps, ObservatoryProps, ReplayProps, ScenarioGalleryProps, ScheduleProps, SurgeryProps } from './api.ts';
import { Waiting } from './components/ui.tsx';

class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

type Loader = () => Promise<Record<string, unknown>>;
type Mount<P> = ComponentType<P & { fallback?: ReactNode; loading?: string }> & { available: boolean };

function optional<P extends object>(mods: Record<string, Loader>, name: string): Mount<P> {
  const load = Object.values(mods)[0];
  const Impl = load ? lazy(async () => ({ default: (await load())[name] as ComponentType<P> })) : null;
  const M = (props: P & { fallback?: ReactNode; loading?: string }) => {
    const { fallback = null, loading = 'Loading', ...rest } = props;
    if (!Impl) return <>{fallback}</>;
    return (
      <Boundary fallback={fallback}>
        <Suspense fallback={<Waiting>{loading}</Waiting>}>
          <Impl {...(rest as P)} />
        </Suspense>
      </Boundary>
    );
  };
  M.available = !!Impl;
  return M as Mount<P>;
}

export const Observatory = optional<ObservatoryProps>(import.meta.glob<Record<string, unknown>>('./observatory/index.{ts,tsx}'), 'Observatory');
export const Schedule = optional<ScheduleProps>(import.meta.glob<Record<string, unknown>>('./schedule/index.{ts,tsx}'), 'Schedule');
export const EvidenceTrail = optional<EvidenceTrailProps>(import.meta.glob<Record<string, unknown>>('./evidence/index.{ts,tsx}'), 'EvidenceTrail');
export const Replay = optional<ReplayProps>(import.meta.glob<Record<string, unknown>>('./replay/index.{ts,tsx}'), 'Replay');
export const Forge = optional<ForgeProps>(import.meta.glob<Record<string, unknown>>('./forge/index.{ts,tsx}'), 'Forge');
export const ScenarioGallery = optional<ScenarioGalleryProps>(import.meta.glob<Record<string, unknown>>('./scenarios/index.{ts,tsx}'), 'ScenarioGallery');
export const Surgery = optional<SurgeryProps>(import.meta.glob<Record<string, unknown>>('./surgery/index.{ts,tsx}'), 'Surgery');
export const SellerTerminal = optional<object>(import.meta.glob<Record<string, unknown>>('./seller/index.{ts,tsx}'), 'SellerTerminal');

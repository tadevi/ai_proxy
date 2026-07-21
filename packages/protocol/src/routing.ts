export type CapabilityRoute = {
  id: string;
  enabled: boolean;
  position: number;
  supportsImages: 'yes' | 'no' | 'unknown';
  supportsTools: 'yes' | 'no' | 'unknown';
};

export function eligibleRoutes(
  routes: CapabilityRoute[],
  containsImages: boolean,
  containsTools: boolean,
) {
  const eligible: CapabilityRoute[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const route of [...routes].sort((a, b) => a.position - b.position)) {
    if (!route.enabled) {
      skipped.push({ id: route.id, reason: 'disabled' });
    } else if (containsImages && route.supportsImages === 'no') {
      skipped.push({ id: route.id, reason: 'images_unsupported' });
    } else if (containsTools && route.supportsTools === 'no') {
      skipped.push({ id: route.id, reason: 'tools_unsupported' });
    } else {
      eligible.push(route);
    }
  }
  return { eligible, skipped };
}

export function isFallbackableStatus(status: number) {
  return [429, 500, 502, 503, 504].includes(status);
}

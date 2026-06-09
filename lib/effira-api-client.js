'use strict';

const API_BASE_URL = 'https://unstable-developers.enerflex.cloud/api/v1';
const TOKEN_SKEW_MS = 60 * 1000;
const DEFAULT_TIME_ZONE = 'Europe/Stockholm';

class EffiraApiClient {
  constructor({ keyId, secret, fetchImpl = global.fetch }) {
    this.keyId = keyId;
    this.secret = secret;
    this.fetch = fetchImpl;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async testCredentials() {
    await this.getAccessToken();
    return true;
  }

  async listAssets() {
    const response = await this.request('/assets');
    return response?.objects || response || [];
  }

  async getCurrentStatus(assetId) {
    return this.request(`/assets/${encodeURIComponent(assetId)}/currentStatus`);
  }

  async getLatestTemperature(assetId, sensorId = null) {
    const now = new Date();
    const from = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const params = new URLSearchParams({
      from: from.toISOString(),
      to: now.toISOString(),
    });

    if (sensorId) {
      params.set('sensorId', sensorId);
    }

    const data = await this.request(
      `/assets/${encodeURIComponent(assetId)}/tempsensor?${params.toString()}`
    );

    if (!Array.isArray(data) || data.length === 0) {
      return null;
    }

    return data
      .slice()
      .sort((left, right) => new Date(right.timeStamp) - new Date(left.timeStamp))[0];
  }

  async getDailyHeatpumpConsumption(assetId, timeZone = DEFAULT_TIME_ZONE) {
    const { start, stop } = getCurrentDayRange(timeZone);
    const params = new URLSearchParams({
      start,
      stop,
      resolution: 'P1D',
      timeZone,
    });
    const data = await this.request(
      `/assets/${encodeURIComponent(assetId)}/heatpumpConsumption?${params.toString()}`
    );
    const val = data?.total?.consumption ?? data?.data?.consumption ?? null;
    return val;
  }

  async getPreviousHourHeatpumpConsumption(assetId, timeZone = DEFAULT_TIME_ZONE) {
    const { start, stop } = getPreviousHourRange(timeZone);
    const params = new URLSearchParams({
      start,
      stop,
      resolution: 'PT1H',
      timeZone,
    });
    const data = await this.request(
      `/assets/${encodeURIComponent(assetId)}/heatpumpConsumption?${params.toString()}`
    );

    if (Array.isArray(data?.data) && data.data.length > 0) {
      const latestBucket = data.data
        .slice()
        .sort((left, right) => new Date(right.start || 0) - new Date(left.start || 0))[0];
      return latestBucket?.consumption ?? null;
    }

    return data?.total?.consumption ?? data?.data?.consumption ?? null;
  }

  async getCurrentPlannedControl(assetId, timeZone = DEFAULT_TIME_ZONE) {
    const now = new Date();
    const start = new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString();
    const stop = new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString();
    const params = new URLSearchParams({
      start,
      stop,
      includeAssetEvents: 'false',
    });
    const response = await this.request(
      `/assets/${encodeURIComponent(assetId)}/timeline?${params.toString()}`
    );
    const timelineResponse = normalizeTimelineResponse(response);

    if (!timelineResponse) {
      return null;
    }

    const currentItem =
      findActiveTimelineItem(timelineResponse.timeline, now) ||
      findActiveTimelineItem(timelineResponse.schedules, now);

    if (!currentItem) {
      return null;
    }

    return {
      state: currentItem.state || 'unknown',
      reason: currentItem.reason || 'unknown',
      mode: currentItem.control?.mode || 'unknown',
      priority: currentItem.priority?.name || 'unknown',
      type: currentItem.type || 'schedule',
      start: currentItem.start || null,
      end: currentItem.end || null,
    };
  }

  async getManualPlan(assetId) {
    return this.request(`/assets/${encodeURIComponent(assetId)}/plan/manual`);
  }

  async setManualPlan(assetId, periods) {
    return this.request(`/assets/${encodeURIComponent(assetId)}/plan/manual`, {
      method: 'POST',
      body: JSON.stringify({ periods }),
    });
  }

  async request(path, options = {}) {
    const token = await this.getAccessToken();
    const response = await this.fetch(`${API_BASE_URL}${path}`, {
      method: options.method || 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: options.body,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Effira API ${response.status}: ${body || response.statusText}`);
    }

    if (response.status === 204) {
      return null;
    }

    return response.json();
  }

  async getAccessToken() {
    const now = Date.now();
    if (this.token && now < this.tokenExpiresAt - TOKEN_SKEW_MS) {
      return this.token;
    }

    if (!this.keyId || !this.secret) {
      throw new Error('Effira credentials are missing');
    }

    const basic = Buffer.from(`${this.keyId}:${this.secret}`, 'utf8').toString('base64');
    const response = await this.fetch(`${API_BASE_URL}/auth/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Effira access token auth failed ${response.status}: ${body || response.statusText}`
      );
    }

    const payload = await response.json();
    this.token = payload.accessToken || payload.access_token;
    this.tokenExpiresAt =
      now + Number(payload.expiresIn || payload.expires_in || 3600) * 1000;

    if (!this.token) {
      throw new Error('Effira auth did not return an access token');
    }

    return this.token;
  }
}

function getCurrentDayRange(timeZone) {
  const now = new Date();
  const parts = getDateTimeParts(now, timeZone);
  let startUtcMs = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);

  for (let i = 0; i < 3; i += 1) {
    const offsetMs = getTimeZoneOffsetMs(new Date(startUtcMs), timeZone);
    startUtcMs = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0) - offsetMs;
  }

  return {
    start: new Date(startUtcMs).toISOString(),
    stop: now.toISOString(),
  };
}

function getPreviousHourRange(timeZone) {
  const now = new Date();
  const parts = getDateTimeParts(now, timeZone);
  let currentHourUtcMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, 0, 0);

  for (let i = 0; i < 3; i += 1) {
    const offsetMs = getTimeZoneOffsetMs(new Date(currentHourUtcMs), timeZone);
    currentHourUtcMs =
      Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, 0, 0) - offsetMs;
  }

  const previousHourUtcMs = currentHourUtcMs - 60 * 60 * 1000;

  return {
    start: new Date(previousHourUtcMs).toISOString(),
    stop: new Date(currentHourUtcMs).toISOString(),
  };
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = getDateTimeParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );

  return asUtc - date.getTime();
}

function getDateTimeParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = formatter.formatToParts(date);

  return {
    year: Number(parts.find((part) => part.type === 'year').value),
    month: Number(parts.find((part) => part.type === 'month').value),
    day: Number(parts.find((part) => part.type === 'day').value),
    hour: Number(parts.find((part) => part.type === 'hour').value),
    minute: Number(parts.find((part) => part.type === 'minute').value),
    second: Number(parts.find((part) => part.type === 'second').value),
  };
}

function normalizeTimelineResponse(response) {
  if (!response) {
    return null;
  }

  if (Array.isArray(response)) {
    return response[0] || null;
  }

  if (Array.isArray(response.timeline) || Array.isArray(response.schedules)) {
    return response;
  }

  if (Array.isArray(response.objects)) {
    return response.objects[0] || null;
  }

  if (Array.isArray(response.schedules) && response.schedules[0]?.timeline) {
    return response.schedules[0];
  }

  return null;
}

function findActiveTimelineItem(items, now) {
  if (!Array.isArray(items)) {
    return null;
  }

  return items.find((item) => {
    const start = item?.start ? new Date(item.start).getTime() : Number.NaN;
    const end = item?.end ? new Date(item.end).getTime() : Number.NaN;

    return Number.isFinite(start) && Number.isFinite(end)
      ? start <= now.getTime() && now.getTime() < end
      : false;
  }) || null;
}

module.exports = EffiraApiClient;

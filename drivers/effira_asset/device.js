'use strict';

const Homey = require('homey');
const EffiraApiClient = require('../../lib/effira-api-client');

const POLL_INTERVAL_MS = 15 * 60 * 1000;

module.exports = class EffiraAssetDevice extends Homey.Device {
  async onInit() {
    this.pollTimer = null;
    this.midnightTimer = null;
    this.api = this.createApiClient();
    await this.refreshNow();
    this.startPolling();
    this.scheduleMidnightRefresh();
  }

  async onDeleted() {
    this.stopPolling();
    this.clearMidnightRefresh();
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.some((key) => ['keyId', 'secret', 'sensorId'].includes(key))) {
      this.api = this.createApiClient(newSettings);
      await this.refreshNow();
    }
  }

  createApiClient(settings = this.getSettings()) {
    return new EffiraApiClient({
      keyId: settings.keyId,
      secret: settings.secret,
    });
  }

  startPolling() {
    this.stopPolling();
    this.pollTimer = this.homey.setInterval(() => {
      this.refreshNow().catch((error) => this.error(error));
    }, POLL_INTERVAL_MS);
  }

  stopPolling() {
    if (this.pollTimer) {
      this.homey.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  scheduleMidnightRefresh() {
    this.clearMidnightRefresh();
    const delay = msUntilNextMidnight('Europe/Stockholm');
    this.midnightTimer = this.homey.setTimeout(async () => {
      try {
        await this.refreshNow();
      } catch (error) {
        this.error(error);
      } finally {
        this.scheduleMidnightRefresh();
      }
    }, delay);
  }

  clearMidnightRefresh() {
    if (this.midnightTimer) {
      this.homey.clearTimeout(this.midnightTimer);
      this.midnightTimer = null;
    }
  }

  async refreshNow() {
    const settings = this.getSettings();
    const assetId = settings.assetId || this.getData().id;

    try {
      const [
        status,
        latestTemp,
        manualPlan,
        dailyHeatpumpConsumption,
        previousHourHeatpumpConsumption,
        plannedControl,
      ] =
        await Promise.all([
          this.api.getCurrentStatus(assetId),
          this.api.getLatestTemperature(assetId),
          this.api.getManualPlan(assetId),
          this.api.getDailyHeatpumpConsumption(assetId),
          this.api.getPreviousHourHeatpumpConsumption(assetId),
          this.api.getCurrentPlannedControl(assetId),
        ]);

      const previousPlannedControl = this.getStoreValue('plannedControl') || null;
      const previousDailyHeatpumpConsumption = this.getStoreValue('dailyHeatpumpConsumption') ?? null;
      const previousPreviousHourHeatpumpConsumption =
        this.getStoreValue('previousHourHeatpumpConsumption') ?? null;
      const previousTemperature = numberOrNull(this.getCapabilityValue('measure_temperature'));
      const currentDailyHeatpumpConsumption = numberOrNull(dailyHeatpumpConsumption);
      const currentPreviousHourHeatpumpConsumption = numberOrNull(previousHourHeatpumpConsumption);
      const currentPlannedControl = normalizePlannedControl(plannedControl);
      const currentTemperature = numberOrNull(latestTemp?.temperature);

      await Promise.all([
        this.setCapabilityValue('alarm_generic', !Boolean(status?.online?.value)),
        this.setCapabilityValue('effira_control_state', currentPlannedControl.state),
        setCapabilityIfDefined(
          this,
          'measure_temperature',
          currentTemperature
        ),
        setCapabilityIfDefined(
          this,
          'effira_heatpump_consumption_day',
          currentDailyHeatpumpConsumption
        ),
        setCapabilityIfDefined(
          this,
          'meter_heatpump_consumption_last_hour',
          currentPreviousHourHeatpumpConsumption
        ),
      ]);

      await this.setStoreValue('plannedControl', currentPlannedControl);
      await this.setStoreValue('dailyHeatpumpConsumption', currentDailyHeatpumpConsumption);
      await this.setStoreValue(
        'previousHourHeatpumpConsumption',
        currentPreviousHourHeatpumpConsumption
      );

      if (
        previousPlannedControl !== null &&
        !isSamePlannedControl(previousPlannedControl, currentPlannedControl)
      ) {
        await this.homey.app.plannedControlChangedTrigger.trigger(
          this,
          {
            state: currentPlannedControl.state,
            previous_state: previousPlannedControl.state,
          },
          {
            state: currentPlannedControl.state,
            previous_state: previousPlannedControl.state,
          }
        );
      }

      if (
        previousDailyHeatpumpConsumption !== null &&
        currentDailyHeatpumpConsumption !== null &&
        previousDailyHeatpumpConsumption !== currentDailyHeatpumpConsumption
      ) {
        await this.homey.app.heatpumpConsumptionChangedTrigger.trigger(
          this,
          {
            consumption_kwh: currentDailyHeatpumpConsumption,
            previous_consumption_kwh: previousDailyHeatpumpConsumption,
          },
          {
            consumption_kwh: currentDailyHeatpumpConsumption,
            previous_consumption_kwh: previousDailyHeatpumpConsumption,
          }
        );
      }

      if (
        previousPreviousHourHeatpumpConsumption !== null &&
        currentPreviousHourHeatpumpConsumption !== null &&
        previousPreviousHourHeatpumpConsumption !== currentPreviousHourHeatpumpConsumption
      ) {
        await this.homey.app.previousHourHeatpumpConsumptionChangedTrigger.trigger(
          this,
          {
            consumption_kwh: currentPreviousHourHeatpumpConsumption,
            previous_consumption_kwh: previousPreviousHourHeatpumpConsumption,
          },
          {
            consumption_kwh: currentPreviousHourHeatpumpConsumption,
            previous_consumption_kwh: previousPreviousHourHeatpumpConsumption,
          }
        );
      }

      if (
        previousTemperature !== null &&
        currentTemperature !== null &&
        previousTemperature !== currentTemperature
      ) {
        await this.homey.app.temperatureChangedTrigger.trigger(
          this,
          {
            temperature_c: currentTemperature,
            previous_temperature_c: previousTemperature,
          },
          {
            temperature_c: currentTemperature,
            previous_temperature_c: previousTemperature,
          }
        );
      }

      await this.setAvailable();
    } catch (error) {
      await this.setUnavailable(error.message);
      throw error;
    }
  }

  async setManualPlan({ action, start, end }) {
    const assetId = this.getSettings().assetId || this.getData().id;
    const period = validateManualPlanPeriod({ action, start, end });
    await this.api.setManualPlan(assetId, [period]);
    await this.refreshNow();
  }

  async setManualPlanFromNow({ action, durationMinutes }) {
    const duration = Number(durationMinutes);

    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('Duration must be a positive number of minutes');
    }

    if (duration % 15 !== 0) {
      throw new Error('Duration must be divisible by 15 minutes');
    }

    const startDate = nextQuarterBoundary(new Date());
    const endDate = new Date(startDate.getTime() + duration * 60 * 1000);

    await this.setManualPlan({
      action,
      start: startDate.toISOString(),
      end: endDate.toISOString(),
    });
  }

  async clearManualPlan() {
    const assetId = this.getSettings().assetId || this.getData().id;
    await this.api.setManualPlan(assetId, []);
    await this.refreshNow();
  }

  getDailyHeatpumpConsumption() {
    return this.getCapabilityValue('effira_heatpump_consumption_day') || 0;
  }

  getPreviousHourHeatpumpConsumption() {
    return numberOrNull(this.getCapabilityValue('meter_heatpump_consumption_last_hour'));
  }

  getTemperature() {
    return numberOrNull(this.getCapabilityValue('measure_temperature'));
  }
};

function validateManualPlanPeriod({ action, start, end }) {
  if (!['boost', 'normal', 'stop'].includes(action)) {
    throw new Error('Action must be boost, normal or stop');
  }

  const startDate = parseUtcIsoString(start, 'start');
  const endDate = parseUtcIsoString(end, 'end');

  if (endDate <= startDate) {
    throw new Error('End must be later than start');
  }

  ensureQuarterAligned(startDate, 'start');
  ensureQuarterAligned(endDate, 'end');

  const earliest = nextQuarterBoundary(new Date());
  if (startDate < earliest) {
    throw new Error(`Start must be no earlier than ${earliest.toISOString()}`);
  }

  const latestAllowed = new Date(Date.now() + 24 * 60 * 60 * 1000);
  if (endDate > latestAllowed) {
    throw new Error('End must be within 24 hours from now');
  }

  return {
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    action,
  };
}

function parseUtcIsoString(value, label) {
  if (typeof value !== 'string' || !value.endsWith('Z')) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp ending with Z`);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} is not a valid timestamp`);
  }

  return parsed;
}

function ensureQuarterAligned(date, label) {
  if (
    date.getUTCSeconds() !== 0 ||
    date.getUTCMilliseconds() !== 0 ||
    ![0, 15, 30, 45].includes(date.getUTCMinutes())
  ) {
    throw new Error(`${label} must be aligned to a 15-minute boundary`);
  }
}

function nextQuarterBoundary(now) {
  const rounded = new Date(now);
  rounded.setUTCSeconds(0, 0);
  const minutes = rounded.getUTCMinutes();
  const nextQuarter = Math.floor(minutes / 15) * 15 + 15;

  if (nextQuarter >= 60) {
    rounded.setUTCHours(rounded.getUTCHours() + 1, 0, 0, 0);
  } else {
    rounded.setUTCMinutes(nextQuarter, 0, 0);
  }

  return rounded;
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function normalizePlannedControl(control) {
  return {
    state: control?.state || 'unknown',
    reason: control?.reason || 'unknown',
    mode: control?.mode || 'unknown',
    priority: control?.priority || 'unknown',
  };
}

function isSamePlannedControl(left, right) {
  return (
    left?.state === right?.state &&
    left?.reason === right?.reason &&
    left?.mode === right?.mode &&
    left?.priority === right?.priority
  );
}

async function setCapabilityIfDefined(device, capabilityId, value) {
  if (value === null || value === undefined) {
    return;
  }

  await device.setCapabilityValue(capabilityId, value);
}

function msUntilNextMidnight(timeZone) {
  const now = new Date();
  const parts = getDateTimeParts(now, timeZone);
  let nextMidnightUtcMs = Date.UTC(parts.year, parts.month - 1, parts.day + 1, 0, 0, 5);

  for (let i = 0; i < 3; i += 1) {
    const offsetMs = getTimeZoneOffsetMs(new Date(nextMidnightUtcMs), timeZone);
    nextMidnightUtcMs =
      Date.UTC(parts.year, parts.month - 1, parts.day + 1, 0, 0, 5) - offsetMs;
  }

  return Math.max(1000, nextMidnightUtcMs - now.getTime());
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

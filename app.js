'use strict';

const Homey = require('homey');

module.exports = class EffiraApp extends Homey.App {
  async onInit() {
    this.plannedControlChangedTrigger =
      this.homey.flow.getDeviceTriggerCard('planned_control_changed');
    this.heatpumpConsumptionChangedTrigger =
      this.homey.flow.getDeviceTriggerCard('heatpump_consumption_changed');
    this.previousHourHeatpumpConsumptionChangedTrigger =
      this.homey.flow.getDeviceTriggerCard('previous_hour_heatpump_consumption_changed');
    this.temperatureChangedTrigger =
      this.homey.flow.getDeviceTriggerCard('temperature_changed');
    this.dailyHeatpumpConsumptionAboveCondition =
      this.homey.flow.getConditionCard('daily_heatpump_consumption_above');
    this.dailyHeatpumpConsumptionBelowCondition =
      this.homey.flow.getConditionCard('daily_heatpump_consumption_below');
    this.previousHourHeatpumpConsumptionAboveCondition =
      this.homey.flow.getConditionCard('previous_hour_heatpump_consumption_above');
    this.previousHourHeatpumpConsumptionBelowCondition =
      this.homey.flow.getConditionCard('previous_hour_heatpump_consumption_below');
    this.temperatureBelowCondition =
      this.homey.flow.getConditionCard('temperature_below');
    this.temperatureAboveCondition =
      this.homey.flow.getConditionCard('temperature_above');

    this.plannedControlChangedTrigger.registerRunListener(async (args, state) => {
      const expectedState = args.state?.id || args.state || 'any';
      return matchesExpected(expectedState, state.state);
    });

    this.homey.flow
      .getActionCard('set_manual_plan')
      .registerRunListener(async ({ device, action, start, end }) => {
        await device.setManualPlan({
          action: action.id || action,
          start,
          end,
        });
        return true;
      });

    this.homey.flow
      .getActionCard('set_manual_plan_from_now')
      .registerRunListener(async ({ device, action, duration_minutes }) => {
        await device.setManualPlanFromNow({
          action: action.id || action,
          durationMinutes: duration_minutes,
        });
        return true;
      });

    this.homey.flow
      .getActionCard('clear_manual_plan')
      .registerRunListener(async ({ device }) => {
        await device.clearManualPlan();
        return true;
      });

    this.homey.flow
      .getActionCard('refresh_asset')
      .registerRunListener(async ({ device }) => {
        await device.refreshNow();
        return true;
      });

    this.dailyHeatpumpConsumptionAboveCondition.registerRunListener(
      async ({ device, threshold_kwh }) => device.getDailyHeatpumpConsumption() > threshold_kwh
    );

    this.dailyHeatpumpConsumptionBelowCondition.registerRunListener(
      async ({ device, threshold_kwh }) => device.getDailyHeatpumpConsumption() < threshold_kwh
    );

    this.previousHourHeatpumpConsumptionAboveCondition.registerRunListener(
      async ({ device, threshold_kwh }) => {
        const consumption = device.getPreviousHourHeatpumpConsumption();
        return consumption !== null && consumption > threshold_kwh;
      }
    );

    this.previousHourHeatpumpConsumptionBelowCondition.registerRunListener(
      async ({ device, threshold_kwh }) => {
        const consumption = device.getPreviousHourHeatpumpConsumption();
        return consumption !== null && consumption < threshold_kwh;
      }
    );

    this.temperatureBelowCondition.registerRunListener(
      async ({ device, threshold_c }) => {
        const temperature = device.getTemperature();
        return temperature !== null && temperature < threshold_c;
      }
    );

    this.temperatureAboveCondition.registerRunListener(
      async ({ device, threshold_c }) => {
        const temperature = device.getTemperature();
        return temperature !== null && temperature > threshold_c;
      }
    );

    this.log('Effira app has been initialized');
  }
};

function matchesExpected(expected, actual) {
  return expected === 'any' || expected === actual;
}

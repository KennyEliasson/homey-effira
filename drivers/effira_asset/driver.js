'use strict';

const Homey = require('homey');
const EffiraApiClient = require('../../lib/effira-api-client');

function buildAssetName(asset) {
  const line = [asset.address?.address1, asset.address?.city].filter(Boolean).join(', ');
  return line || asset.clientId || asset.assetId;
}

module.exports = class EffiraAssetDriver extends Homey.Driver {
  async onInit() {
    this.log('Effira asset driver initialized');
  }

  async onPair(session) {
    let keyId = '';
    let secret = '';

    session.setHandler('login', async ({ username, password }) => {
      keyId = String(username || '').trim();
      secret = String(password || '').trim();

      const api = new EffiraApiClient({ keyId, secret });
      return api.testCredentials();
    });

    session.setHandler('list_devices', async () => {
      const api = new EffiraApiClient({ keyId, secret });
      const assets = await api.listAssets();

      return assets.map((asset) => ({
        name: buildAssetName(asset),
        data: {
          id: asset.assetId,
        },
        settings: {
          assetId: asset.assetId,
          clientId: asset.clientId || '',
          keyId,
          secret,
          sensorId: asset.sensors?.[0]?.sensorId || '',
        },
        store: {
          assetSnapshot: {
            assetId: asset.assetId,
            clientId: asset.clientId || null,
            address: asset.address || null,
          },
        },
      }));
    });
  }
};

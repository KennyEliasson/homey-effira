'use strict';

const fs = require('fs');
const path = require('path');

const mode = process.argv[2];

const MODES = {
  'cloud-dev': {
    appPlatforms: ['local', 'cloud'],
    driverPlatforms: ['local', 'cloud'],
    flowPlatforms: ['local', 'cloud'],
    driverConnectivity: ['cloud'],
    apiBaseUrl: 'https://unstable-developers.enerflex.cloud/api/v1',
  },
  'local-release': {
    appPlatforms: ['local'],
    driverPlatforms: ['local'],
    flowPlatforms: ['local'],
    driverConnectivity: ['cloud'],
    apiBaseUrl: 'https://developers.enerflex.cloud/api/v1',
  },
};

if (!MODES[mode]) {
  process.stderr.write(
    `Unknown mode "${mode}". Expected one of: ${Object.keys(MODES).join(', ')}\n`
  );
  process.exit(1);
}

const rootDir = path.resolve(__dirname, '..');
const config = MODES[mode];
const lockPath = path.join(rootDir, '.homey-mode.lock');

function readJson(relativePath) {
  const filePath = path.join(rootDir, relativePath);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(relativePath, value) {
  const filePath = path.join(rootDir, relativePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function withLock(task) {
  let lockFd;

  try {
    lockFd = fs.openSync(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') {
      process.stderr.write('Another homey mode switch is already running.\n');
      process.exit(1);
    }
    throw error;
  }

  try {
    task();
  } finally {
    fs.closeSync(lockFd);
    fs.unlinkSync(lockPath);
  }
}

function setPlatformsOnComposeFlows() {
  const flowDir = path.join(rootDir, '.homeycompose', 'flow');
  const sections = ['actions', 'conditions', 'triggers'];

  for (const section of sections) {
    const sectionDir = path.join(flowDir, section);
    const fileNames = fs.readdirSync(sectionDir).filter((fileName) => fileName.endsWith('.json'));

    for (const fileName of fileNames) {
      const relativePath = path.join('.homeycompose', 'flow', section, fileName);
      const flowCard = readJson(relativePath);
      flowCard.platforms = config.flowPlatforms;
      writeJson(relativePath, flowCard);
    }
  }
}

function setPlatformsOnComposeApp() {
  const relativePath = path.join('.homeycompose', 'app.json');
  const appManifest = readJson(relativePath);
  appManifest.platforms = config.appPlatforms;
  writeJson(relativePath, appManifest);
}

function setPlatformsOnComposeDriver() {
  const relativePath = path.join('drivers', 'effira_asset', 'driver.compose.json');
  const driverManifest = readJson(relativePath);
  driverManifest.platforms = config.driverPlatforms;
  driverManifest.connectivity = config.driverConnectivity;
  writeJson(relativePath, driverManifest);
}

function setPlatformsOnBuiltApp() {
  const relativePath = path.join('app.json');
  const appManifest = readJson(relativePath);

  appManifest.platforms = config.appPlatforms;

  if (appManifest.flow) {
    for (const flowType of ['triggers', 'conditions', 'actions']) {
      if (!Array.isArray(appManifest.flow[flowType])) {
        continue;
      }

      for (const flowCard of appManifest.flow[flowType]) {
        flowCard.platforms = config.flowPlatforms;
      }
    }
  }

  if (Array.isArray(appManifest.drivers)) {
    for (const driver of appManifest.drivers) {
      if (driver.id === 'effira_asset') {
        driver.platforms = config.driverPlatforms;
        driver.connectivity = config.driverConnectivity;
      }
    }
  }

  writeJson(relativePath, appManifest);
}

function setApiConfig() {
  const relativePath = path.join('lib', 'effira-api-config.json');
  writeJson(relativePath, {
    apiBaseUrl: config.apiBaseUrl,
  });
}

withLock(() => {
  setPlatformsOnComposeApp();
  setPlatformsOnComposeDriver();
  setPlatformsOnComposeFlows();
  setPlatformsOnBuiltApp();
  setApiConfig();
});

process.stdout.write(`Updated manifests for mode: ${mode}\n`);

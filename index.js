/**
 * @format
 */

import {AppRegistry, DeviceEventEmitter, Image} from 'react-native';
import App, {REFRESH_EVENT} from './App';
import {name as appName} from './app.json';

import {PluginManager} from 'sn-plugin-lib';
import {loadSettings} from './src/settings';

const BUTTON_WIDTH = 301;
/** Lasso toolbar button shown when the selection holds strokes (0) or shapes (5). */
const EDIT_TYPES = [0, 5];

AppRegistry.registerComponent(appName, () => App);

PluginManager.init();
loadSettings();

const BUTTON = {
  id: BUTTON_WIDTH,
  name: 'Inkwell',
  icon: Image.resolveAssetSource(require('./assets/icon_width.png')).uri,
  editDataTypes: EDIT_TYPES,
  showType: 1,
};

/**
 * Panel as a centred dialog (regionType 1) sized to its content, so the note
 * stays visible around it. The keys come from the SDK's native side
 * (PluginButtonKey: regionType / regionWidth / regionHeight, in pixels) and are
 * not documented for JavaScript: if the host refuses them, the button is
 * registered again without, as before (full-screen panel).
 */
const DIALOG = {regionType: 1, regionWidth: 1440, regionHeight: 1240};

PluginManager.registerButton(2, ['NOTE', 'DOC'], {
  ...BUTTON,
  ...DIALOG,
  showData: DIALOG,
})
  .then(ok => ok || PluginManager.registerButton(2, ['NOTE', 'DOC'], BUTTON))
  .catch(() => PluginManager.registerButton(2, ['NOTE', 'DOC'], BUTTON));

PluginManager.registerButtonListener({
  onButtonPress(event) {
    if (event.id === BUTTON_WIDTH) {
      // The panel may already be mounted from a previous use: re-read the new selection.
      DeviceEventEmitter.emit(REFRESH_EVENT);
    }
  },
});

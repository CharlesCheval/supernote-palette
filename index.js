/**
 * @format
 */

import {AppRegistry, DeviceEventEmitter, Image} from 'react-native';
import App, {REFRESH_EVENT} from './App';
import {name as appName} from './app.json';

import {PluginManager} from 'sn-plugin-lib';

const BUTTON_WIDTH = 301;
/** Lasso toolbar button shown when the selection holds strokes (0) or shapes (5). */
const EDIT_TYPES = [0, 5];

AppRegistry.registerComponent(appName, () => App);

PluginManager.init();

PluginManager.registerButton(2, ['NOTE', 'DOC'], {
  id: BUTTON_WIDTH,
  name: 'Stroke width',
  icon: Image.resolveAssetSource(require('./assets/icon_width.png')).uri,
  editDataTypes: EDIT_TYPES,
  showType: 1,
});

PluginManager.registerButtonListener({
  onButtonPress(event) {
    if (event.id === BUTTON_WIDTH) {
      // The panel may already be mounted from a previous use: re-read the new selection.
      DeviceEventEmitter.emit(REFRESH_EVENT);
    }
  },
});

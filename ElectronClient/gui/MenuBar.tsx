import { useEffect, useState, useRef, useCallback } from 'react';
import { AppState } from '../app';
import InteropService from 'lib/services/interop/InteropService';
import { stateUtils } from 'lib/reducer';
import CommandService from 'lib/services/CommandService';
import MenuUtils from 'lib/services/commands/MenuUtils';
import KeymapService from 'lib/services/KeymapService';
import { utils as pluginUtils, ViewInfo } from 'lib/services/plugins/reducer';
import shim from 'lib/shim';
import Setting from 'lib/models/Setting';
import versionInfo from 'lib/versionInfo';
import { Module } from 'lib/services/interop/types';
import InteropServiceHelper from '../InteropServiceHelper';
import { _ } from 'lib/locale';
import { MenuItemLocation } from 'lib/services/plugins/api/types';

const { connect } = require('react-redux');
const { reg } = require('lib/registry.js');
const packageInfo = require('../packageInfo.js');
const bridge = require('electron').remote.require('./bridge').default;
const { shell, clipboard } = require('electron');
const Menu = bridge().Menu;
const PluginManager = require('lib/services/PluginManager');
const TemplateUtils = require('lib/TemplateUtils');

interface Props {
	dispatch: Function,
	menuItemProps: any,
	routeName: string,
	selectedFolderId: string,
	layoutButtonSequence: number,
	['notes.sortOrder.field']: string,
	['folders.sortOrder.field']: string,
	['notes.sortOrder.reverse']: boolean,
	['folders.sortOrder.reverse']: boolean,
	showNoteCounts: boolean,
	uncompletedTodosOnTop: boolean,
	showCompletedTodos: boolean,
	pluginMenuItemInfos: ViewInfo[],
}

const commandNames:string[] = [
	'focusElementSideBar',
	'focusElementNoteList',
	'focusElementNoteTitle',
	'focusElementNoteBody',
	'exportPdf',
	'newNote',
	'newTodo',
	'newFolder',
	'print',
	'synchronize',
	'textCopy',
	'textCut',
	'textPaste',
	'textSelectAll',
	'textBold',
	'textItalic',
	'textLink',
	'textCode',
	'insertDateTime',
	'attachFile',
	'focusSearch',
	'showLocalSearch',
	'toggleSidebar',
	'toggleNoteList',
	'toggleVisiblePanes',
	'toggleExternalEditing',
	'setTags',
	'showNoteContentProperties',
	'copyDevCommand',
];

function menuItemSetChecked(id:string, checked:boolean) {
	const menu = Menu.getApplicationMenu();
	const menuItem = menu.getMenuItemById(id);
	if (!menuItem) return;
	menuItem.checked = checked;
}

function menuItemSetEnabled(id:string, enabled:boolean) {
	const menu = Menu.getApplicationMenu();
	const menuItem = menu.getMenuItemById(id);
	if (!menuItem) return;
	menuItem.enabled = enabled;
}

const menuUtils = new MenuUtils(CommandService.instance());

function useMenu(props:Props) {
	const [menu, setMenu] = useState(null);
	const [keymapLastChangeTime, setKeymapLastChangeTime] = useState(Date.now());
	const [modulesLastChangeTime, setModulesLastChangeTime] = useState(Date.now());

	const onMenuItemClick = useCallback((commandName:string) => {
		CommandService.instance().execute(commandName, props.menuItemProps[commandName]);
	}, [props.menuItemProps]);

	const onImportModuleClick = useCallback(async (module:Module, moduleSource:string) => {
		let path = null;

		if (moduleSource === 'file') {
			path = bridge().showOpenDialog({
				filters: [{ name: module.description, extensions: module.fileExtensions }],
			});
		} else {
			path = bridge().showOpenDialog({
				properties: ['openDirectory', 'createDirectory'],
			});
		}

		if (!path || (Array.isArray(path) && !path.length)) return;

		if (Array.isArray(path)) path = path[0];

		CommandService.instance().execute('showModalMessage', { message: _('Importing from "%s" as "%s" format. Please wait...', path, module.format) });

		const importOptions = {
			path,
			format: module.format,
			modulePath: module.path,
			onError: console.warn,
			destinationFolderId: !module.isNoteArchive && moduleSource === 'file' ? props.selectedFolderId : null,
		};

		const service = InteropService.instance();
		try {
			const result = await service.import(importOptions);
			console.info('Import result: ', result);
		} catch (error) {
			bridge().showErrorMessageBox(error.message);
		}

		CommandService.instance().execute('hideModalMessage');
	}, [props.selectedFolderId]);

	const onMenuItemClickRef = useRef(null);
	onMenuItemClickRef.current = onMenuItemClick;

	const onImportModuleClickRef = useRef(null);
	onImportModuleClickRef.current = onImportModuleClick;

	useEffect(() => {
		const keymapService = KeymapService.instance();

		const pluginCommandNames = props.pluginMenuItemInfos.map((viewInfo:ViewInfo) => viewInfo.view.commandName);
		const menuItemDic = menuUtils.commandsToMenuItems(commandNames.concat(pluginCommandNames), (commandName:string) => onMenuItemClickRef.current(commandName));

		const quitMenuItem = {
			label: _('Quit'),
			accelerator: keymapService.getAccelerator('quit'),
			click: () => { bridge().electronApp().quit(); },
		};

		const sortNoteFolderItems = (type:string) => {
			const sortItems = [];
			const sortOptions = Setting.enumOptions(`${type}.sortOrder.field`);
			for (const field in sortOptions) {
				if (!sortOptions.hasOwnProperty(field)) continue;
				sortItems.push({
					id: `sort:${type}:${field}`,
					label: sortOptions[field],
					type: 'checkbox',
					// checked: Setting.value(`${type}.sortOrder.field`) === field,
					click: () => {
						Setting.setValue(`${type}.sortOrder.field`, field);
					},
				});
			}

			sortItems.push({ type: 'separator' });

			sortItems.push({
				id: `sort:${type}:reverse`,
				label: Setting.settingMetadata(`${type}.sortOrder.reverse`).label(),
				type: 'checkbox',
				// checked: Setting.value(`${type}.sortOrder.reverse`),
				click: () => {
					Setting.setValue(`${type}.sortOrder.reverse`, !Setting.value(`${type}.sortOrder.reverse`));
				},
			});

			return sortItems;
		};

		const sortNoteItems = sortNoteFolderItems('notes');
		const sortFolderItems = sortNoteFolderItems('folders');

		const focusItems = [
			menuItemDic.focusElementSideBar,
			menuItemDic.focusElementNoteList,
			menuItemDic.focusElementNoteTitle,
			menuItemDic.focusElementNoteBody,
		];

		let toolsItems:any[] = [];
		const importItems = [];
		const exportItems = [];
		const toolsItemsFirst = [];
		const templateItems:any[] = [];
		const ioService = InteropService.instance();
		const ioModules = ioService.modules();
		for (let i = 0; i < ioModules.length; i++) {
			const module = ioModules[i];
			if (module.type === 'exporter') {
				if (module.isNoteArchive !== false) {
					exportItems.push({
						label: module.fullLabel(),
						click: async () => {
							await InteropServiceHelper.export(props.dispatch.bind(this), module);
						},
					});
				}
			} else {
				for (let j = 0; j < module.sources.length; j++) {
					const moduleSource = module.sources[j];
					importItems.push({
						label: module.fullLabel(moduleSource),
						click: () => onImportModuleClickRef.current(module, moduleSource),
					});
				}
			}
		}

		exportItems.push(
			menuItemDic.exportPdf
		);

		// We need a dummy entry, otherwise the ternary operator to show a
		// menu item only on a specific OS does not work.
		const noItem = {
			type: 'separator',
			visible: false,
		};

		const syncStatusItem = {
			label: _('Synchronisation Status'),
			click: () => {
				props.dispatch({
					type: 'NAV_GO',
					routeName: 'Status',
				});
			},
		};

		const newNoteItem = menuItemDic.newNote;
		const newTodoItem = menuItemDic.newTodo;
		const newFolderItem = menuItemDic.newFolder;
		const printItem = menuItemDic.print;

		toolsItemsFirst.push(syncStatusItem, {
			type: 'separator',
		});

		templateItems.push({
			label: _('Create note from template'),
			click: () => {
				CommandService.instance().execute('selectTemplate', { noteType: 'note' });
			},
		}, {
			label: _('Create to-do from template'),
			click: () => {
				CommandService.instance().execute('selectTemplate', { noteType: 'todo' });
			},
		}, {
			label: _('Insert template'),
			accelerator: keymapService.getAccelerator('insertTemplate'),
			click: () => {
				CommandService.instance().execute('selectTemplate');
			},
		}, {
			label: _('Open template directory'),
			click: () => {
				shell.openItem(Setting.value('templateDir'));
			},
		}, {
			label: _('Refresh templates'),
			click: async () => {
				const templates = await TemplateUtils.loadTemplates(Setting.value('templateDir'));

				this.store().dispatch({
					type: 'TEMPLATE_UPDATE_ALL',
					templates: templates,
				});
			},
		});

		// we need this workaround, because on macOS the menu is different
		const toolsItemsWindowsLinux:any[] = toolsItemsFirst.concat([{
			label: _('Options'),
			visible: !shim.isMac(),
			accelerator: !shim.isMac() && keymapService.getAccelerator('config'),
			click: () => {
				props.dispatch({
					type: 'NAV_GO',
					routeName: 'Config',
				});
			},
		} as any]);

		// the following menu items will be available for all OS under Tools
		const toolsItemsAll = [{
			label: _('Note attachments...'),
			click: () => {
				props.dispatch({
					type: 'NAV_GO',
					routeName: 'Resources',
				});
			},
		}];

		if (!shim.isMac()) {
			toolsItems = toolsItems.concat(toolsItemsWindowsLinux);
		}
		toolsItems = toolsItems.concat(toolsItemsAll);

		function _checkForUpdates(ctx:any) {
			bridge().checkForUpdates(false, bridge().window(), ctx.checkForUpdateLoggerPath(), { includePreReleases: Setting.value('autoUpdate.includePreReleases') });
		}

		function _showAbout() {
			const v = versionInfo(packageInfo);

			const copyToClipboard = bridge().showMessageBox(v.message, {
				icon: `${bridge().electronApp().buildDir()}/icons/128x128.png`,
				buttons: [_('Copy'), _('OK')],
				cancelId: 1,
				defaultId: 1,
			});

			if (copyToClipboard === 0) {
				clipboard.writeText(v.message);
			}
		}

		const rootMenuFile = {
			// Using a dummy entry for macOS here, because first menu
			// becomes 'Joplin' and we need a nenu called 'File' later.
			label: shim.isMac() ? '&JoplinMainMenu' : _('&File'),
			// `&` before one of the char in the label name mean, that
			// <Alt + F> will open this menu. It's needed becase electron
			// opens the first menu on Alt press if no hotkey assigned.
			// Issue: https://github.com/laurent22/joplin/issues/934
			submenu: [{
				label: _('About Joplin'),
				visible: shim.isMac() ? true : false,
				click: () => _showAbout(),
			}, {
				type: 'separator',
				visible: shim.isMac() ? true : false,
			}, {
				label: _('Preferences...'),
				visible: shim.isMac() ? true : false,
				accelerator: shim.isMac() && keymapService.getAccelerator('config'),
				click: () => {
					props.dispatch({
						type: 'NAV_GO',
						routeName: 'Config',
					});
				},
			}, {
				label: _('Check for updates...'),
				visible: shim.isMac() ? true : false,
				click: () => _checkForUpdates(this),
			}, {
				type: 'separator',
				visible: shim.isMac() ? true : false,
			},
			shim.isMac() ? noItem : newNoteItem,
			shim.isMac() ? noItem : newTodoItem,
			shim.isMac() ? noItem : newFolderItem, {
				type: 'separator',
				visible: shim.isMac() ? false : true,
			}, {
				label: _('Templates'),
				visible: shim.isMac() ? false : true,
				submenu: templateItems,
			}, {
				type: 'separator',
				visible: shim.isMac() ? false : true,
			}, {
				label: _('Import'),
				visible: shim.isMac() ? false : true,
				submenu: importItems,
			}, {
				label: _('Export all'),
				visible: shim.isMac() ? false : true,
				submenu: exportItems,
			}, {
				type: 'separator',
			},

			menuItemDic.synchronize,

			shim.isMac() ? syncStatusItem : noItem, {
				type: 'separator',
			}, shim.isMac() ? noItem : printItem, {
				type: 'separator',
				platforms: ['darwin'],
			},

			!shim.isMac() ? noItem : {
				label: _('Hide %s', 'Joplin'),
				platforms: ['darwin'],
				accelerator: shim.isMac() && keymapService.getAccelerator('hideApp'),
				click: () => { bridge().electronApp().hide(); },
			},

			{
				type: 'separator',
			},
			quitMenuItem],
		};

		const rootMenuFileMacOs = {
			label: _('&File'),
			visible: shim.isMac() ? true : false,
			submenu: [
				newNoteItem,
				newTodoItem,
				newFolderItem, {
					label: _('Close Window'),
					platforms: ['darwin'],
					accelerator: shim.isMac() && keymapService.getAccelerator('closeWindow'),
					selector: 'performClose:',
				}, {
					type: 'separator',
				}, {
					label: _('Templates'),
					submenu: templateItems,
				}, {
					type: 'separator',
				}, {
					label: _('Import'),
					submenu: importItems,
				}, {
					label: _('Export'),
					submenu: exportItems,
				}, {
					type: 'separator',
				},
				printItem,
			],
		};

		const layoutButtonSequenceOptions = Setting.enumOptions('layoutButtonSequence');
		const layoutButtonSequenceMenuItems = [];

		for (const value in layoutButtonSequenceOptions) {
			layoutButtonSequenceMenuItems.push({
				id: `layoutButtonSequence_${value}`,
				label: layoutButtonSequenceOptions[value],
				type: 'checkbox',
				click: () => {
					Setting.setValue('layoutButtonSequence', value);
				},
			});
		}

		const separator = () => {
			return {
				type: 'separator',
			};
		};

		const rootMenus:any = {
			edit: {
				id: 'edit',
				label: _('&Edit'),
				submenu: [
					menuItemDic.textCopy,
					menuItemDic.textCut,
					menuItemDic.textPaste,
					menuItemDic.textSelectAll,
					separator(),
					menuItemDic.textBold,
					menuItemDic.textItalic,
					menuItemDic.textLink,
					menuItemDic.textCode,
					separator(),
					menuItemDic.insertDateTime,
					menuItemDic.attachFile,
					separator(),
					menuItemDic.focusSearch,
					menuItemDic.showLocalSearch,
				],
			},
			view: {
				label: _('&View'),
				submenu: [
					menuItemDic.toggleSidebar,
					menuItemDic.toggleNoteList,
					menuItemDic.toggleVisiblePanes,
					{
						label: _('Layout button sequence'),
						submenu: layoutButtonSequenceMenuItems,
					},
					separator(),
					{
						label: Setting.settingMetadata('notes.sortOrder.field').label(),
						submenu: sortNoteItems,
					}, {
						label: Setting.settingMetadata('folders.sortOrder.field').label(),
						submenu: sortFolderItems,
					}, {
						id: 'showNoteCounts',
						label: Setting.settingMetadata('showNoteCounts').label(),
						type: 'checkbox',
						// checked: Setting.value('showNoteCounts'),
						click: () => {
							Setting.setValue('showNoteCounts', !Setting.value('showNoteCounts'));
						},
					}, {
						id: 'uncompletedTodosOnTop',
						label: Setting.settingMetadata('uncompletedTodosOnTop').label(),
						type: 'checkbox',
						// checked: Setting.value('uncompletedTodosOnTop'),
						click: () => {
							Setting.setValue('uncompletedTodosOnTop', !Setting.value('uncompletedTodosOnTop'));
						},
					}, {
						id: 'showCompletedTodos',
						label: Setting.settingMetadata('showCompletedTodos').label(),
						type: 'checkbox',
						// checked: Setting.value('showCompletedTodos'),
						click: () => {
							Setting.setValue('showCompletedTodos', !Setting.value('showCompletedTodos'));
						},
					},
					separator(),
					{
						label: _('Focus'),
						submenu: focusItems,
					},
					separator(),
					{
						label: _('Actual Size'),
						click: () => {
							Setting.setValue('windowContentZoomFactor', 100);
						},
						accelerator: 'CommandOrControl+0',
					}, {
					// There are 2 shortcuts for the action 'zoom in', mainly to increase the user experience.
					// Most applications handle this the same way. These applications indicate Ctrl +, but actually mean Ctrl =.
					// In fact they allow both: + and =. On the English keyboard layout - and = are used without the shift key.
					// So to use Ctrl + would mean to use the shift key, but this is not the case in any of the apps that show Ctrl +.
					// Additionally it allows the use of the plus key on the numpad.
						label: _('Zoom In'),
						click: () => {
							Setting.incValue('windowContentZoomFactor', 10);
						},
						accelerator: 'CommandOrControl+Plus',
					}, {
						label: _('Zoom In'),
						visible: false,
						click: () => {
							Setting.incValue('windowContentZoomFactor', 10);
						},
						accelerator: 'CommandOrControl+=',
					}, {
						label: _('Zoom Out'),
						click: () => {
							Setting.incValue('windowContentZoomFactor', -10);
						},
						accelerator: 'CommandOrControl+-',
					}],
			},
			note: {
				label: _('&Note'),
				submenu: [
					menuItemDic.toggleExternalEditing,
					menuItemDic.setTags,
					separator(),
					menuItemDic.showNoteContentProperties,
				],
			},
			tools: {
				label: _('&Tools'),
				submenu: toolsItems,
			},
			help: {
				label: _('&Help'),
				role: 'help', // Makes it add the "Search" field on macOS
				submenu: [{
					label: _('Website and documentation'),
					accelerator: keymapService.getAccelerator('help'),
					click() { bridge().openExternal('https://joplinapp.org'); },
				}, {
					label: _('Joplin Forum'),
					click() { bridge().openExternal('https://discourse.joplinapp.org'); },
				}, {
					label: _('Make a donation'),
					click() { bridge().openExternal('https://joplinapp.org/donate/'); },
				}, {
					label: _('Check for updates...'),
					visible: shim.isMac() ? false : true,
					click: () => _checkForUpdates(this),
				},
				separator(),
				{
					id: 'help:toggleDevTools',
					label: _('Toggle development tools'),
					click: () => {
						props.dispatch({
							type: 'NOTE_DEVTOOLS_TOGGLE',
						});
					},
				},

				menuItemDic.copyDevCommand,

				{
					type: 'separator',
					visible: shim.isMac() ? false : true,
				}, {
					label: _('About Joplin'),
					visible: shim.isMac() ? false : true,
					click: () => _showAbout(),
				}],
			},
		};

		if (shim.isMac()) {
			rootMenus.macOsApp = rootMenuFile;
			rootMenus.file = rootMenuFileMacOs;
		} else {
			rootMenus.file = rootMenuFile;
		}

		// It seems the "visible" property of separators is ignored by Electron, making
		// it display separators that we want hidden. So this function iterates through
		// them and remove them completely.
		const cleanUpSeparators = (items:any[]) => {
			const output = [];
			for (const item of items) {
				if ('visible' in item && item.type === 'separator' && !item.visible) continue;
				output.push(item);
			}
			return output;
		};

		for (const key in rootMenus) {
			if (!rootMenus.hasOwnProperty(key)) continue;
			if (!rootMenus[key].submenu) continue;
			rootMenus[key].submenu = cleanUpSeparators(rootMenus[key].submenu);
		}

		const pluginMenuItems = PluginManager.instance().menuItems();
		for (const item of pluginMenuItems) {
			const itemParent = rootMenus[item.parent] ? rootMenus[item.parent] : 'tools';
			itemParent.submenu.push(item);
		}

		// TODO: test

		const pluginViewInfos = props.pluginMenuItemInfos;

		for (const info of pluginViewInfos) {
			const location:MenuItemLocation = info.view.location;
			if (location === MenuItemLocation.Context) continue;

			const itemParent = rootMenus[location];

			if (!itemParent) {
				reg.logger().error('Menu item location does not exist: ', location, info);
			} else {
				itemParent.submenu.push(menuItemDic[info.view.commandName]);
			}
		}

		const template = [
			rootMenus.file,
			rootMenus.edit,
			rootMenus.view,
			rootMenus.note,
			rootMenus.tools,
			rootMenus.help,
		];

		if (shim.isMac()) template.splice(0, 0, rootMenus.macOsApp);

		// TODO

		// function isEmptyMenu(template:any[]) {
		// 	for (let i = 0; i < template.length; i++) {
		// 		const t = template[i];
		// 		if (t.type !== 'separator') return false;
		// 	}
		// 	return true;
		// }

		// function removeUnwantedItems(template:any[], screen:string) {
		// 	const platform = shim.platformName();

		// 	let output = [];
		// 	for (let i = 0; i < template.length; i++) {
		// 		const t = Object.assign({}, template[i]);
		// 		if (t.screens && t.screens.indexOf(screen) < 0) continue;
		// 		if (t.platforms && t.platforms.indexOf(platform) < 0) continue;
		// 		if (t.submenu) t.submenu = removeUnwantedItems(t.submenu, screen);
		// 		if (('submenu' in t) && isEmptyMenu(t.submenu)) continue;
		// 		output.push(t);
		// 	}

		// 	// Remove empty separator for now empty sections
		// 	const temp = [];
		// 	let previous = null;
		// 	for (let i = 0; i < output.length; i++) {
		// 		const t = Object.assign({}, output[i]);
		// 		if (t.type === 'separator') {
		// 			if (!previous) continue;
		// 			if (previous.type === 'separator') continue;
		// 		}
		// 		temp.push(t);
		// 		previous = t;
		// 	}
		// 	output = temp;

		// 	return output;
		// }

		if (props.routeName !== 'Main') {
			setMenu(Menu.buildFromTemplate([
				{
					label: _('&File'),
					submenu: [quitMenuItem],
				},
			]));
		} else {
			setMenu(Menu.buildFromTemplate(template));
		}
	}, [props.routeName, props.pluginMenuItemInfos, keymapLastChangeTime, modulesLastChangeTime]);

	useEffect(() => {
		for (const commandName in props.menuItemProps) {
			if (!props.menuItemProps[commandName]) continue;
			menuItemSetEnabled(commandName, CommandService.instance().isEnabled(commandName, props.menuItemProps[commandName]));
		}

		const layoutButtonSequenceOptions = Setting.enumOptions('layoutButtonSequence');
		for (const value in layoutButtonSequenceOptions) {
			menuItemSetEnabled(`layoutButtonSequence_${value}`, props.layoutButtonSequence === Number(value));
		}

		function applySortItemCheckState(type:string) {
			const sortOptions = Setting.enumOptions(`${type}.sortOrder.field`);
			for (const field in sortOptions) {
				if (!sortOptions.hasOwnProperty(field)) continue;
				menuItemSetChecked(`sort:${type}:${field}`, (props as any)[`${type}.sortOrder.field`] === field);
			}

			menuItemSetChecked(`sort:${type}:reverse`, (props as any)[`${type}.sortOrder.reverse`]);
		}

		applySortItemCheckState('notes');
		applySortItemCheckState('folders');

		menuItemSetChecked('showNoteCounts', props.showNoteCounts);
		menuItemSetChecked('uncompletedTodosOnTop', props.uncompletedTodosOnTop);
		menuItemSetChecked('showCompletedTodos', props.showCompletedTodos);
	}, [
		props.menuItemProps,
		props.layoutButtonSequence,
		props['notes.sortOrder.field'],
		props['folders.sortOrder.field'],
		props['notes.sortOrder.reverse'],
		props['folders.sortOrder.reverse'],
		props.showNoteCounts,
		props.uncompletedTodosOnTop,
		props.showCompletedTodos,
	]);

	useEffect(() => {
		function onKeymapChange() {
			setKeymapLastChangeTime(Date.now());
		}

		KeymapService.instance().on('keymapChange', onKeymapChange);

		return () => {
			KeymapService.instance().off('keymapChange', onKeymapChange);
		};
	}, []);

	useEffect(() => {
		function onModulesChanged() {
			setModulesLastChangeTime(Date.now());
		}

		InteropService.instance().on('modulesChanged', onModulesChanged);

		return () => {
			InteropService.instance().off('modulesChanged', onModulesChanged);
		};
	}, []);

	return menu;
}

function MenuBar(props:Props):JSX.Element {
	const menu = useMenu(props);
	if (menu) Menu.setApplicationMenu(menu);
	return null;
}

const mapStateToProps = (state:AppState) => {
	return {
		menuItemProps: menuUtils.commandsToMenuItemProps(state, commandNames),
		routeName: state.route.routeName,
		selectedFolderId: state.selectedFolderId,
		layoutButtonSequence: state.settings.layoutButtonSequence,
		['notes.sortOrder.field']: state.settings['notes.sortOrder.field'],
		['folders.sortOrder.field']: state.settings['folders.sortOrder.field'],
		['notes.sortOrder.reverse']: state.settings['notes.sortOrder.reverse'],
		['folders.sortOrder.reverse']: state.settings['folders.sortOrder.reverse'],
		showNoteCounts: state.settings.showNoteCounts,
		uncompletedTodosOnTop: state.settings.uncompletedTodosOnTop,
		showCompletedTodos: state.settings.showCompletedTodos,
		pluginMenuItemInfos: stateUtils.selectArrayShallow({ array: pluginUtils.viewInfosByType(state.pluginService.plugins, 'menuItem') }, 'menuBar.pluginMenuItemInfos'),
	};
};

export default connect(mapStateToProps)(MenuBar);

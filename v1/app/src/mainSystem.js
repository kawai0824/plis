//////////////////////////////////////////////////////////////////////
//	Copyright (C) Hiroshi SUGIMURA 2020.10.30
//////////////////////////////////////////////////////////////////////
'use strict'

//////////////////////////////////////////////////////////////////////
// 基本ライブラリ
const Store   = require('electron-store');
const { objectSort, getNow, getToday, isObjEmpty, mergeDeeply } = require('./mainSubmodule');

// 基礎設定
const appDir = process.env.NODE_ENV === 'development' ? __dirname : __dirname;
let sendIPCMessage = null;
const store = new Store();

let config = {  // config.system
	screenMode: 'window',
	windowWidth: 1024,
	windowHeight: 768,
	resultExpireDays: 365,
	ellogExpireDays: 30,
	IPver: 0,
	IPv4: '',
	IPv6: '',
	debug: false
};


//////////////////////////////////////////////////////////////////////
// EL関連
let mainSystem = {

	start: async function ( _sendIPCMessage ) {
		sendIPCMessage = _sendIPCMessage;
		// config.system
		config.screenMode   = await store.get('config.system.screenMode',   config.screenMode);
		config.windowWidth  = await store.get('config.system.windowWidth',  config.windowWidth);
		config.windowHeight = await store.get('config.system.windowHeight', config.windowHeight);
		config.resultExpireDays = await store.get('config.system.resultExpireDays', config.resultExpireDays);
		config.ellogExpireDays = await store.get('config.system.ellogExpireDays', config.ellogExpireDays);
		config.IPver        = await store.get('config.system.IPver',        config.IPver);
		config.IPv4         = await store.get('config.system.IPv4',         config.IPv4);
		config.IPv6         = await store.get('config.system.IPv6',         config.IPv6);
		config.debug        = await store.get('config.system.debug',        config.debug);

		config.debug?console.log( new Date().toFormat("YYYY-MM-DDTHH24:MI:SS"), '| mainSystem.start()'):0;
	},

	stop: async function () {
		config.debug?console.log( new Date().toFormat("YYYY-MM-DDTHH24:MI:SS"), '| mainSystem.stop()'):0;
		await mainSystem.setConfig( config );
	},

	setConfig: async function  ( _config ) {
		if( _config ) {
			config = mergeDeeply( config, _config );
		}
		await store.set('config.system', config);
		sendIPCMessage( "renewSystemConfigView", config );
		sendIPCMessage( "configSaved", 'System' );
	},

	getConfig: function () {
		return config;
	}
};

module.exports = mainSystem;
//////////////////////////////////////////////////////////////////////
// EOF
//////////////////////////////////////////////////////////////////////

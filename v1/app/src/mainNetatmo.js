//////////////////////////////////////////////////////////////////////
//	Copyright (C) Hiroshi SUGIMURA 2018.03.16
//////////////////////////////////////////////////////////////////////
'use strict'

//////////////////////////////////////////////////////////////////////
// 基本ライブラリ
const Store = require('electron-store');
const netatmo = require('netatmo');
const cron = require('node-cron');
require('date-utils');// for log
const { Sequelize, Op, sqlite3, netatmoModel, roomEnvModel } = require('./models/localDBModels');// DBデータと連携
const  {objectSort, getNow, getToday, isObjEmpty, mergeDeeply} = require('./mainSubmodule');

let sendIPCMessage = null;
const store = new Store();
let config = {
	enabled: false,
	id: "",
	secret: "",
	username: "",
	password: "",
	debug: false
};
let persist = {};


//////////////////////////////////////////////////////////////////////
// config
let mainNetatmo = {
	api: null,
	observationJob: null,
	data: {},
	debug: false,
	callback: null,
	isRun: false,

	//////////////////////////////////////////////////////////////////////
	// netatmo start
	start: function ( _sendIPCMessage ) {
		sendIPCMessage = _sendIPCMessage;

		if( mainNetatmo.isRun ) {
			sendIPCMessage( "renewNetatmoConfigView", config );
			sendIPCMessage( "renewNetatmo", persist );
			mainNetatmo.sendTodayRoomEnv();// 現在持っているデータを送っておく
			return;
		}

		config.enabled  = store.get('config.Netatmo.enabled', false);
		config.id       = store.get('config.Netatmo.id', '');
		config.secret   = store.get('config.Netatmo.secret', '');
		config.username = store.get('config.Netatmo.username', '');
		config.password = store.get('config.Netatmo.password', '');
		config.debug    = store.get('config.Netatmo.debug', false);
		sendIPCMessage( "renewNetatmoConfigView", config );

		persist = store.get('persist.Netatmo', {});

		if( !config.enabled ) {
			config.debug?console.log( new Date().toFormat("YYYY-MM-DDTHH24:MI:SS"), '| mainNetatmo.start() Netatmo is disabled.'):0;
		mainNetatmo.isRun = false;
			return;
		}
		mainNetatmo.isRun = true;

		// configがなければ実行しない。
		if( config.id == '' || config.secret == '' || config.username == '' || config.password == '') {
			config.debug?console.log( new Date().toFormat("YYYY-MM-DDTHH24:MI:SS"), '| mainNetatmo.start() no config.'):0;
			return;
		}

		config.debug?console.log( new Date().toFormat("YYYY-MM-DDTHH24:MI:SS"), '| mainNetatmo.start() config:\x1b[32m', _config, '\x1b[0m'):0;

		try{
			mainNetatmo.api = new netatmo({ 'client_id' : config.id, 'client_secret' : config.secret, 'username' : config.username, 'password' : config.password });
			mainNetatmo.data = {};
			mainNetatmo.callback = function (err, devices) {
				if(err) {
					console.error(err);
					return;
				}
				persist = devices;
				sendIPCMessage( "renewNetatmo", persist );
				netatmoModel.create({ detail: JSON.stringify(persist) });// dbに入れる
			};

			mainNetatmo.api.on('get-stationsdata', (err, devices) => {// イベント登録
				mainNetatmo.callback(err, devices);
			});

			mainNetatmo.setObserve();// 定期的チェック開始
		} catch(e) {
			console.error( new Date().toFormat("YYYY-MM-DDTHH24:MI:SS"), '| mainNetatmo.start() error:', e);
		}

		sendIPCMessage( "renewNetatmo", persist );

		mainNetatmo.sendTodayRoomEnv();// 現在持っているデータを送っておく
	},


	//////////////////////////////////////////////////////////////////////
	// Netatmoの処理


	stop: async function () {
		mainNetatmo.isRun = false;
		config.debug?console.log( new Date().toFormat("YYYY-MM-DDTHH24:MI:SS"), '| mainNetatmo.stop()'):0;

		await mainNetatmo.setConfig( config );
		await store.set('persist.Netatmo', persist);
		await mainNetatmo.stopObservation();
	},

	stopWithoutSave: async function () {
		mainNetatmo.isRun = false;
		config.debug?console.log( new Date().toFormat("YYYY-MM-DDTHH24:MI:SS"), '| mainNetatmo.stopWithoutSave()'):0;
		await mainNetatmo.stopObservation();
	},


	setConfig: async function ( _config ) {
		if( _config ) {
			config = mergeDeeply( config, _config );
		}
		await store.set('config.Netatmo', config);
		sendIPCMessage( "renewNetatmoConfigView", config );
		sendIPCMessage( "configSaved", 'Netatmo' );// 保存したので画面に通知
	},

	getConfig: function () {
		return config;
	},

	getPersist: function() {
		return persist;
	},


	//////////////////////////////////////////////////////////////////////
	// innser functions

	// 定時処理、部屋環境のデータ送信
	/*
	getCases
	input
		date: Date="2023-01-06"

	output
		when createdAt >= "2023-01-05 23:57" and createdAt < "2023-01-06 00:00" then "00:00"
		when createdAt >= "2023-01-06 00:00" and createdAt < "2023-01-06 00:03" then "00:03"
		when createdAt >= "2023-01-06 00:03" and createdAt < "2023-01-06 00:06" then "00:06"
		...
		when createdAt >= "2023-01-06 23:54" and createdAt < "2023-01-06 23:57" then "23:57"
		else "24:00"
	*/
	getCases: function ( date ) {
		let T1 = new Date(date);
		let T2 = new Date(date);
		let T3 = new Date(date);
		let T4 = new Date(date);

		// UTCだがStringにて表現しているので、なんか複雑
		T1.setHours( T1.getHours() - T1.getHours() -10, 57, 0, 0 );// 前日の14時57分xx秒   14:57:00 .. 15:00:00 --> 00:00
		T2.setHours( T1.getHours() - T1.getHours() -10, 58, 0, 0 );// T1 + 1min
		T3.setHours( T1.getHours() - T1.getHours() -10, 59, 0, 0 );// T1 + 2min
		T4.setHours( T1.getHours() - T1.getHours()    ,  0, 0, 0 );// 集約先

		let ret = "";
		for( let t=0; t<480; t+=1 ) {// 24h * 20 times (= 60min / 3min)
			// console.log( T1.toISOString(), ':', T1.toFormat('YYYY-MM-DD HH24:MI'), ', ', T4.toFormat('HH24:MI') );

			ret += `WHEN "createdAt" LIKE "${T1.toFormat('YYYY-MM-DD HH24:MI')}%" OR "createdAt" LIKE "${T2.toFormat('YYYY-MM-DD HH24:MI')}%" OR "createdAt" LIKE "${T3.toFormat('YYYY-MM-DD HH24:MI')}%" THEN "${T4.toFormat('HH24:MI')}" \n`;

			T1.setMinutes( T1.getMinutes() +3 );// + 3 min
			T2.setMinutes( T2.getMinutes() +3 );// + 3 min
			T3.setMinutes( T3.getMinutes() +3 );// + 3 min
			T4.setMinutes( T4.getMinutes() +3 );// + 3 min
		}
		return ret + 'ELSE "24:00"';
	},


	// DBからテーブル取得
	getRows: async function() {
		try {
			let now = new Date();// 現在
			let begin = new Date(now);// 現在時刻UTCで取得
			begin.setHours( begin.getHours() - begin.getHours() - 1, 57, 0, 0 );// 前日の23時57分０秒にする
			let end = new Date(begin);// 現在時刻UTCで取得
			end.setHours( begin.getHours() + 25, 0, 0, 0 );// 次の日の00:00:00にする
			let cases = mainNetatmo.getCases( now );

			let subQuery = `CASE ${cases} END`;

			// 3分毎データ
			let rows = await roomEnvModel.findAll( {
				attributes: ['id',
							 [Sequelize.fn('AVG', Sequelize.col('temperature')), 'avgTemperature'],
							 [Sequelize.fn('AVG', Sequelize.col('humidity')), 'avgHumidity'],
							 [Sequelize.fn('AVG', Sequelize.col('pressure')), 'avgPressure'],
							 [Sequelize.fn('AVG', Sequelize.col('CO2')), 'avgCO2'],
							 [Sequelize.fn('AVG', Sequelize.col('noise')), 'avgNoise'],
							 'createdAt',
							 [Sequelize.literal(subQuery), 'timeunit']
							 ],
				where: {
					srcType: 'netatmo',
					dateTime: { [Op.between] : [begin.toISOString(), end.toISOString()] }
				},
				group: ['timeunit']
			} );

			return rows;
		} catch( error ) {
			console.error( new Date().toFormat("YYYY-MM-DDTHH24:MI:SS"), '| mainNetatmo.getRows()', error);
		}
	},

	getTodayRoomEnv: async function( ) {
		// 画面に今日のデータを送信するためのデータ作る
		try {
			let rows = await mainNetatmo.getRows();

			let T1 = new Date();
			T1.setHours( 0, 0, 0);

			let array = [];
			for( let t=0; t<480; t+=1 ) {
				let row = rows.find( (row) => row.dataValues.timeunit == T1.toFormat('HH24:MI') );

				if( row ) {
					array.push( {
						id: t,
						time: T1.toISOString(),
						srcType: 'netatmo',
						temperature: row.dataValues.avgTemperature,
						humidity: row.dataValues.avgHumidity,
						pressure: row.dataValues.avgPressure,
						noise: row.dataValues.avgNoise,
						CO2: row.dataValues.avgCO2
					} );
				}else{
					array.push( {
						id: t,
						time: T1.toISOString(),
						srcType: 'omron',
						temperature: null,
						humidity: null,
						pressure: null,
						noise: null,
						CO2: null
					});
				}

				T1.setMinutes( T1.getMinutes() +3 );// + 3 min
			}
			return array;

		} catch( error ) {
			console.error( new Date().toFormat("YYYY-MM-DDTHH24:MI:SS"), '| mainNetatmo.getTodayRoomEnv()', error);
		}
	},

	sendTodayRoomEnv: async function( ) {
		let arg = { };

		if( config.enabled ) {
			arg = await mainNetatmo.getTodayRoomEnv();
			sendIPCMessage( 'renewRoomEnvNetatmo', JSON.stringify(arg));
		}
	},

	// netatmoを監視する
	setObserve: function() {
		if( mainNetatmo.observationJob ) {
			config.debug?console.log( new Date().toFormat("YYYY-MM-DDTHH24:MI:SS"), '| mainNetatmo.observe() is already started.' ):0;
		}
		config.debug?console.log( new Date().toFormat("YYYY-MM-DDTHH24:MI:SS"), '| mainNetatmo.observe() start.' ):0;

		// 監視はcronで実施、1分毎
		mainNetatmo.observationJob = cron.schedule('*/1 * * * *', () => {
			try{
				config.debug?console.log( new Date().toFormat("YYYY-MM-DDTHH24:MI:SS"), '| mainNetatmo.cron.schedule() every 1min'):0;

				// 部屋の環境を記録、Netatmo
				mainNetatmo.api.getStationsData();

				let dt = new Date();

				//------------------------------------------------------------
				// 部屋の環境を記録、Netatmo
				if( config.enabled && persist.length != 0 ) {
					// config.debug ? console.log( new Date().toFormat("YYYY-MM-DDTHH24:MI:SS"), '| mainNetatmo.cron.schedule() Store Netatmo'):0;
					let n = persist[0];
					if( n ) {
						roomEnvModel.create( {
							dateTime: dt,
							srcType: 'netatmo',
							place: n.home_name,
							temperature: n.dashboard_data.Temperature,
							humidity: n.dashboard_data.Humidity,
							pressure: n.dashboard_data.Pressure,
							noise: n.dashboard_data.Noise,
							CO2: n.dashboard_data.CO2} );
					}
				}

				mainNetatmo.sendTodayRoomEnv();// 本日のデータの定期的送信
			} catch( error ) {
				console.error( new Date().toFormat("YYYY-MM-DDTHH24:MI:SS"), '| mainNetatmo.cron.schedule() each 1min, error:', error);
			}
		});

		mainNetatmo.observationJob.start();
	},


	// 監視をやめる
	stopObservation: function() {
		config.debug ? console.log( new Date().toFormat("YYYY-MM-DDTHH24:MI:SS"), '| mainNetatmo.stop() observation.' ):0;

		if( mainNetatmo.observationJob ) {
			mainNetatmo.observationJob.stop();
			mainNetatmo.observationJob = null;
		}
	}
};


module.exports = mainNetatmo;
//////////////////////////////////////////////////////////////////////
// EOF
//////////////////////////////////////////////////////////////////////

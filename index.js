/* 
TERMS OF USE
Open source under the MIT License.
Copyright 2016 Matthijs Logemann All rights reserved.
*/
module.exports = init;

var superagent = require('superagent');
var Service = null;
var Characteristic = null;

function init(homebridge) {
	Service = homebridge.hap.Service;
	Characteristic = homebridge.hap.Characteristic;
	homebridge.registerAccessory('homebridge-thinkingcleaner', 'Roomba', ThinkingCleaner);
}

function ThinkingCleaner(log, config) {
	this.log = log;
	var that = this;

	this.name = config.name;
	this.ip_address = config.ip_address;
	this.dock_on_stop = (typeof config.dock_on_stop === 'undefined' || config.dock_on_stop === "true");

	this.informationService = new Service.AccessoryInformation();
	this.informationService.setCharacteristic(Characteristic.Name, this.name)
	.setCharacteristic(Characteristic.Manufacturer, "Thinking Bits")
	.setCharacteristic(Characteristic.Model, "Thinking Cleaner")
	.setCharacteristic(Characteristic.SerialNumber, "Unknown")
	.setCharacteristic(Characteristic.FirmwareRevision, "Unknown");

	if (!this.ip_address) {
		locateTC.call(this, function(err, cleaner) {
			if (err) throw err;

			// TODO: Find a way to persist this
			that.ip_address = cleaner.local_ip;
			that.cleaner = cleaner;
			that.log("Save the Thinking Cleaner IP address " + cleaner.local_ip + " to your config to skip discovery.");
			getSWVersion.call(that);
		});
	}else {
		getSWVersion.call(this);	
	}
}

var getSWVersion = function() {
	var that = this;
	//		that.informationService.setCharacteristic(Characteristic.SerialNumber, "Loading!");

	superagent.get("http://"+that.ip_address+"/full_status.json").timeout(60000).end(function(error, response) {
		if (error) {
			that.log("Could not load full_status: %s", error.message);
			//				that.informationService.setCharacteristic(Characteristic.SerialNumber, "Unknown!");
		} else {
			var tcObj = JSON.parse(response.text);
			that.log(tcObj.firmware.version);
			//				that.informationService.setCharacteristic(Characteristic.SerialNumber, "Loaded!");
		}
	});
}


var locateTC = function(callback) {
	var that = this;

	// Report the results of the scan to the user
	var getIp = function(err, cleaners) {
		if (!cleaners || cleaners.length === 0) {
			that.log("No Thinking Cleaner devices found.");
			callback(err || new Error("No Thinking Cleaner found"));
			return;
		}

		if (cleaners.length > 1) {
			that.log("Warning: Multiple Thinking Cleaner devices detected. The first Thinking Cleaner will be used automatically. To use a different Thinking Cleaner, set the `ip_address` manually in the configuration.");
		}

		that.log("Thinking Cleaners found:" + (cleaners.map(function(cleaner) {
			// Bridge name is only returned from meethue.com so use id instead if it isn't there
			return " " + cleaner.local_ip + ' - ' + cleaner.name;
		})).join(" "));

		callback(null, cleaners[0]);
	};

	superagent.get("http://tc.thinkingsync.com/api/v1/discover/devices").timeout(60000).end(function(error, response) {
		if (error) {
			this.log("Could not find Thinking Cleaners: %s", error.message);
			getIp(new Error(error));
		} else {
			that.log("Scan complete");

			var tcArr = response.body;

			getIp(null, tcArr);
		}
	});
};

ThinkingCleaner.prototype = {
	setPowerState: function(powerOn, callback) {
		if (powerOn) {
			this.log(this.name + ": Start cleaning");
			superagent.get(this.ip_address + "/command.json?command=clean").end(function(error, response) {
				if (error) {
					this.log("Could not send clean command to Thinking Cleaner: %s", error.message);
					callback(error);
				} else {
					callback();
				}
			});
		} else {
			var that = this;
			
			if (!this.dock_on_stop){

				superagent.get(this.ip_address + "/status.json").end(function(error, response) {
					if (error) {
						that.log("Could not send request status of Thinking Cleaner: %s", error.message);
						callback(error);
					} else {
						var tcObj = JSON.parse(response.text);

						if (tcObj.status.cleaning === "1"){
							that.log(that.name + ": Cleaning, now stopping");
							superagent.get(that.ip_address + "/command.json?command=clean").end(function(error, response) {
								if (error) {
									that.log("Could not send clean command (to stop) to Thinking Cleaner: %s", error.message);
									callback(error);
								} else {
									callback();
								}
							});
						}else{
							that.log(that.name + ": Not cleaning, doing nothing extra");
							callback();
						}
					}
				});
			}else {
				this.log(this.name + ": Start docking");
				superagent.get(this.ip_address + "/command.json?command=dock").end(function(error, response) {
					if (error) {
						this.log("Could not send clean command to Thinking Cleaner: %s", error.message);
						callback(error);
					} else {
						callback();
					}
				});
			}
		}
	},

	getPowerState: function(callback) {
		var url = this.ip_address + "/status.json";

		superagent.get(url).end(function(error, response) {
			if (error) {
				callback(error);
			} else {
				var tcObj = JSON.parse(response.text);

				callback(null, tcObj.status.cleaning === "1");
			}
		});
	},

	getFullStatus: function(callback) {
		var url = this.ip_address + "/full_status.json";

		superagent.get(url).end(function(error, response) {
			if (error) {
				callback(error);
			} else {
				var tcObj = JSON.parse(response.text);

				callback(tcObj);
			}
		});
	},

	getBatteryLevel: function(callback) {
		this.getFullStatus(function(fullstatus){
			callback(null, fullstatus.power_status.battery_charge);
		}.bind(this));
	},

	getChargingState: function(callback) {
		this.getFullStatus(function(fullstatus){
			switch(fullstatus.power_status.cleaner_state) {
				case "st_base":
				case "st_base_wait":
				case "st_plug":
				case "st_plug_wait":
				var chargingstate = 0;
				break;

				case "st_base_recon":
				case "st_base_full":
				case "st_base_trickle":
				case "st_plug_recon":
				case "st_plug_full":
				case "st_plug_trickle":
				var chargingstate = 1;
				break;

				default:
				break;
			}

			callback(null, chargingstate);
		}.bind(this));
	},

	getStatusLowBattery: function(callback) {
		this.getFullStatus(function(fullstatus){
			callback(null, fullstatus.power_status.low_power);
		}.bind(this));
	},

	identify: function(callback) {
		this.log("Identify requested!");
		superagent.get(this.ip_address + "/command.json?command=find_me").end(function(error, response) {
			if (error) {
				this.log("Could not send command to Thinking Cleaner: %s", error.message);
				callback(error);
			} else {
				callback();
			}
		});
	},

	getServices: function() {
		// the default values for things like serial number, model, etc.
		var that = this;
		var switchService = new Service.Switch(this.name);
		var batteryService = new Service.BatteryService(this.name);

		switchService.getCharacteristic(Characteristic.On).on('set', this.setPowerState.bind(this));
		switchService.getCharacteristic(Characteristic.On).on('get', this.getPowerState.bind(this));
		batteryService.getCharacteristic(Characteristic.BatteryLevel).on('get', this.getBatteryLevel.bind(this));
		batteryService.getCharacteristic(Characteristic.ChargingState).on('get', this.getChargingState.bind(this));
		batteryService.getCharacteristic(Characteristic.StatusLowBattery).on('get', this.getStatusLowBattery.bind(this));
		//setTimeout(function () {
		//	that.log("Hey");
		//		that.informationService.setCharacteristic(Characteristic.SerialNumber, "Hi there!");
		//}, 10)

		return [this.informationService, switchService, batteryService];
	}
};

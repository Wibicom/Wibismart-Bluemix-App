
var express = require('express');
var sockjs  = require('sockjs');
var http    = require('http');
var mqtt = require('mqtt');
var websocket_multiplex = require('websocket-multiplex');
var path = require('path');
var macUtil = require('getmac');
var cfenv = require('cfenv');
var properties = require('properties');
var Cloudant = require('cloudant');
var Client = require('ibmiotf');
const toCSV = require('array-to-csv');

//credentials to connect to the watson IoT platform.
var appClientConfig = {
    "org" : "4rxa4d",
    "id": Date.now().toString(),
    "domain": "internetofthings.ibmcloud.com",
    "auth-key" : "a-4rxa4d-grkivvkg6x",
    "auth-token" : "ey?sMBDkxLa0SjzlpJ"
}
 
var appClient = new Client.IotfApplication(appClientConfig);
appClient.connect();

appClient.on('connect', function() {
  console.log('[IBMIoTf] Connected');
});

var appEnv = cfenv.getAppEnv();
var instanceId = !appEnv.isLocal ? appEnv.app.instance_id : undefined;
var iotService = appEnv.getService('Internet of Things Platform-as');
if(instanceId && iotService && iotService != null) {
  console.log('Instance Id: ' + instanceId);
  start(instanceId, iotService.credentials.apiKey, iotService.credentials.apiToken,
    iotService.credentials.mqtt_host, iotService.credentials.mqtt_s_port);
} else {
  properties.parse('./config.properties', {path: true}, function(err, cfg) {
    if (err) {
      console.error('A file named config.properties containing the device registration from the IBM IoT Cloud is missing.');
      console.error('The file must contain the following properties: apikey and apitoken.');
      throw e;
    }
    macUtil.getMac(function(err, macAddress) {
      if (err)  throw err;
      var deviceId = macAddress.replace(/:/gi, '');
      console.log("Device MAC Address: " + deviceId);
      var org = cfg.apikey.split('-')[1];
      start(deviceId, cfg.apikey, cfg.apitoken, org + '.messaging.internetofthings.ibmcloud.com', 
        '8883');
    });
  });
}
function start(deviceId, apiKey, apiToken, mqttHost, mqttPort) {
  var sockjs_opts = {sockjs_url: "https://cdnjs.cloudflare.com/ajax/libs/three.js/r67/three.js"};
  var org = apiKey.split('-')[1];
  var clientId = ['a', org, deviceId].join(':');
  var client = mqtt.connect("mqtts://" + mqttHost + ":" + mqttPort, {
              "clientId" : clientId,
              "keepalive" : 30,
              "username" : apiKey,
              "password" : apiToken
            });
  client.on('connect', function() {
    console.log('MQTT client connected to IBM IoT Cloud.');
  });
  client.on('error', function(err) {
    console.error('client error' + err);
    process.exit(1);
  });
  client.on('close', function() {
    console.log('client closed');
    process.exit(1);
  });

//web socket channel variables
  var service = sockjs.createServer(sockjs_opts);
  var multiplexer = new websocket_multiplex.MultiplexServer(service);
  var accelChannel = multiplexer.registerChannel('accel');
  var airChannel = multiplexer.registerChannel('air');
  var lightChannel = multiplexer.registerChannel('health');
  var CO2Channel = multiplexer.registerChannel('CO2');
  var soundChannel = multiplexer.registerChannel('sound');
  var gasesChannel = multiplexer.registerChannel('gases');
  var batteryChannel = multiplexer.registerChannel('battery');
  var locationChannel = multiplexer.registerChannel('location');
  var dataBaseChannel = multiplexer.registerChannel('dataBase');
  var bulkDataChannel = multiplexer.registerChannel('bulkData');
  var scanChannel = multiplexer.registerChannel('scanCommand');
  var connectionChannel = multiplexer.registerChannel('connectionCommand');
  var disconnectionChannel = multiplexer.registerChannel('disconnectionCommand');
  var sensorToggleChannel = multiplexer.registerChannel('sensorToggleCommand');
  var sensorPeriodChannel = multiplexer.registerChannel('sensorPeriodCommand');
  var getterChannel = multiplexer.registerChannel('getterChannel');
  //var clickChannel = multiplexer.registerChannel('click');
  var mqttTopics = {};
  client.on('message', function(topic, message, packet) {
    console.log("received message");
    var topicSplit = topic.split('/');
    topicSplit[2] = '+'; //Replace the type with the wildcard +
    var conns = mqttTopics[topicSplit.join('/')];
    if(conns) {
      for(var i = 0; i < conns.length; i++) {
        var conn = conns[i];
        if(conn) {
          conn.write(message);
        }
      }
    }
  });

//This function is called lower here when the the websocket opens so it subscribes to mqtt topics
  function onConnection(topicPath) {
    return function(conn) {
      var mqttTopic;
      console.log('Entering onConnection()' + 'Topic' + topicPath);
      conn.lastSubscribedId = null;
      // These listeners behave very strange.  You would think that events would be 
      // broadcast on a per channel per connection basis but that is not the case.
      // Any event is broadcast across all channel and all connections, hence the
      // checking of the topics and connections.
      conn.on('close', function() {
        if(mqttTopic && this.topic === conn.topic && this.conn.id == conn.conn.id) {
          var conns = mqttTopics[mqttTopic];
          if(conns) {
            var index = conns.indexOf(conn);
            if(index != -1) {
              mqttTopics[mqttTopic].splice(index, 1);
              if(conns.length == 0) {
                client.unsubscribe(mqttTopic);
                delete mqttTopics[mqttTopic];
              }
            }
          } 
        }
      });
      conn.on('data', function(data) {
        var dataObj = JSON.parse(data);
        console.log('Received data. Looking to subscribe')
        if(dataObj.deviceId && this.topic === conn.topic && this.conn.id == conn.conn.id) {
          mqttTopic = 'iot-2/type/+/id/' + dataObj.deviceId + topicPath;
            if (this.lastSubscribedId != dataObj.deviceId) {
              if(this.lastSubscribedId != null) {
                var lastMqttTopic = 'iot-2/type/+/id/' + this.lastSubscribedId + topicPath;
                client.unsubscribe(lastMqttTopic);
                delete mqttTopics[lastMqttTopic];
                console.log("Unsubscribing to " + lastMqttTopic);
              }
              this.lastSubscribedId = dataObj.deviceId;
            console.log('Subscribing to topic ' + mqttTopic);
            if(!mqttTopics[mqttTopic] || mqttTopics[mqttTopic].length == 0) {
              mqttTopics[mqttTopic] = [conn];
              client.subscribe(mqttTopic, {qos : 0}, function(err, granted) {
                if (err) throw err;
                console.log("subscribed");
              });
            } else {
              mqttTopics[mqttTopic].push(conn);
            }
          }
        }
      });
    };
  };

//this function is called on opening of a websocket for data is opened from the historical dashboard
function dataRequest() {
  return function(conn) {
    console.log("Data channel connected");
    conn.on('close', function() {
        console.log("Data channel close");
    });

    conn.on('data', function(data) {
      var clientUpdate = setInterval(function() {
        conn.write(JSON.stringify({update:"."}));
      }, 2000);
      var lightData = [];
      var batteryData = [];
      var accelData = [];
      var temperatureData = [];
      var pressureData = [];
      var humidityData = [];
      var UVData = [];
      var soundData = [];
      var CO2Data = [];
      var SO2Data = [];
      var COData = [];
      var O3Data = [];
      var NO2Data = [];
      var PMData = [];
      var rssiData = [];
      var dbList = [];
      var requestObj = JSON.parse(data);
      var uuid = requestObj.uuid;
      var deviceIndex = 0;
      var totalDevices = uuid.length;
      var sent = {};
      for(var a = 0 ; a < totalDevices ; a++) {
        sent[uuid[a]] = false;
      }
      var uuidIndex = {};
      for(var a = 0 ; a < totalDevices ; a++) {
        uuidIndex[uuid[a]] = a;
      }
    	var startDate = requestObj.startDate;
	    var endDate = requestObj.endDate;
      var counter = 0;
	    var doneCounter = 0;
      cloudant.db.list(function(err, allDbs){ //this gets a list of all the databases 
        if (err) {
            throw err;
          }
        for(var i = 0 ; i < allDbs.length ; i++ ) {
          var tempDate = allDbs[i].split('_')[3];
          if ( compareDate(startDate, tempDate) > 0 && compareDate(tempDate, endDate) > 0 ) { //for each database, we check if it is in the correct timeframe.
            counter++;
            var tempInstance = cloudant.db.use(allDbs[i]);
            console.log(tempDate);
            dbList.push(tempInstance);
            

          }// end of if statement
        }//end of for loop
        console.log("Accessing Databases...");
        querryAll(uuid[deviceIndex]);

      });//end of list

      function querryAll(thisUuid) {
        for(var j = 0 ; j < 5 && j < dbList.length ; j++) { // here we only itterate 5 times because Cloudant only allows 5 querries pers second
          tempInstance = dbList[j];
          querry(tempInstance, dbList.length, j+1, thisUuid);
        }
      }

      function querry(tempInstance, dblength, index, thisUuid) { //this function querries a specific database
        console.log('querry for ' + thisUuid +" device "+(deviceIndex+1)+ "/"+ totalDevices + " database " + index + "/" + dblength);
        conn.write(JSON.stringify({message:"Querying data base for " + dbList[index-1].config.db.split('_')[3] + " for device " + thisUuid + ". (" + index + "/" + dblength + " databases)"}));
        //console.log("Querying data base for " + dbList[index-1].config.db.split('_')[3] + " for device " + thisUuid + ". (" + index + "/" + dblength + " database(s))")
            tempInstance.find({ //this will get all the data in a specific instance of a database with a given device id
              "selector": {
                "deviceId" : thisUuid

              },
              "fields": [
                "timestamp",
                "data.d",
                "eventType"

              ],
              "sort": [
                
              ]
              }, function(err, result) { //results represents the data comming back from the database.
                if (err) {
                  throw err;
                }
                for (var i = 0; i < result.docs.length; i++) {//here we push all the point into the appropriate data array
                  var tempDataSet = [];
                  switch(result.docs[i].eventType) {
                    case 'health':
                      tempDataSet.push(result.docs[i].timestamp);
                      extraPointsBefore(tempDataSet, uuidIndex[thisUuid], 1);
                      tempDataSet.push(result.docs[i].data.d.light);
                      extraPointsAfter(tempDataSet, uuidIndex[thisUuid], 1);
                      
                      lightData.push(tempDataSet);
                      break;
                    case 'CO2':
                      tempDataSet.push(result.docs[i].timestamp);
                      extraPointsBefore(tempDataSet, uuidIndex[thisUuid], 1);
                      tempDataSet.push(result.docs[i].data.d.CO2);
                      extraPointsAfter(tempDataSet, uuidIndex[thisUuid], 1);

                      CO2Data.push(tempDataSet);
                      break;
                    case 'sound':
                      tempDataSet.push(result.docs[i].timestamp);
                      extraPointsBefore(tempDataSet, uuidIndex[thisUuid], 1);
                      tempDataSet.push(result.docs[i].data.d.soundLevel);
                      extraPointsAfter(tempDataSet, uuidIndex[thisUuid], 1);

                      soundData.push(tempDataSet);
                      break;
                    case 'gases':
                      tempDataSet.push(result.docs[i].timestamp);
                      extraPointsBefore(tempDataSet, uuidIndex[thisUuid], 1);
                      tempDataSet.push(result.docs[i].data.d.SO2);
                      extraPointsAfter(tempDataSet, uuidIndex[thisUuid], 1);

                      SO2Data.push(tempDataSet);

                      tempDataSet = [];

                      tempDataSet.push(result.docs[i].timestamp);
                      extraPointsBefore(tempDataSet, uuidIndex[thisUuid], 1);
                      tempDataSet.push(result.docs[i].data.d.CO);
                      extraPointsAfter(tempDataSet, uuidIndex[thisUuid], 1);

                      COData.push(tempDataSet);

                      tempDataSet = [];

                      tempDataSet.push(result.docs[i].timestamp);
                      extraPointsBefore(tempDataSet, uuidIndex[thisUuid], 1);
                      tempDataSet.push(result.docs[i].data.d.O3);
                      extraPointsAfter(tempDataSet, uuidIndex[thisUuid], 1);

                      O3Data.push(tempDataSet);

                      tempDataSet = [];

                      tempDataSet.push(result.docs[i].timestamp);
                      extraPointsBefore(tempDataSet, uuidIndex[thisUuid], 1);
                      tempDataSet.push(result.docs[i].data.d.NO2);
                      extraPointsAfter(tempDataSet, uuidIndex[thisUuid], 1);

                      NO2Data.push(tempDataSet);

                      tempDataSet = [];

                      tempDataSet.push(result.docs[i].timestamp);
                      extraPointsBefore(tempDataSet, uuidIndex[thisUuid], 1);
                      tempDataSet.push(result.docs[i].data.d.PM);
                      extraPointsAfter(tempDataSet, uuidIndex[thisUuid], 1);

                      PMData.push(tempDataSet);
                      break;
                    case 'battery':
                      tempDataSet.push(result.docs[i].timestamp);
                      extraPointsBefore(tempDataSet, uuidIndex[thisUuid], 1);
                      tempDataSet.push(result.docs[i].data.d.batteryLevel);
                      extraPointsAfter(tempDataSet, uuidIndex[thisUuid], 1);
                      
                      batteryData.push(tempDataSet);
                      break;
                    case 'location':
                      tempDataSet.push(result.docs[i].timestamp);
                      extraPointsBefore(tempDataSet, uuidIndex[thisUuid], 1);
                      tempDataSet.push(result.docs[i].data.d.rssi);
                      extraPointsAfter(tempDataSet, uuidIndex[thisUuid], 1);
                      
                      rssiData.push(tempDataSet);
                      break;
                    case 'accel':
                      tempDataSet.push(result.docs[i].timestamp);
                      extraPointsBefore(tempDataSet, uuidIndex[thisUuid], 3);
                      tempDataSet.push(result.docs[i].data.d.x);
                      tempDataSet.push(result.docs[i].data.d.y);
                      tempDataSet.push(result.docs[i].data.d.z);
                      extraPointsAfter(tempDataSet, uuidIndex[thisUuid], 3);
                      
                      accelData.push(tempDataSet);
                      break;
                    case 'air':
                      tempDataSet.push(result.docs[i].timestamp);
                      extraPointsBefore(tempDataSet, uuidIndex[thisUuid], 1);
                      tempDataSet.push(result.docs[i].data.d.pressure);
                      extraPointsAfter(tempDataSet, uuidIndex[thisUuid], 1);
                      
                      pressureData.push(tempDataSet);
                      tempDataSet = [];

                      tempDataSet.push(result.docs[i].timestamp);
                      extraPointsBefore(tempDataSet, uuidIndex[thisUuid], 1);
                      tempDataSet.push(result.docs[i].data.d.temperature);
                      extraPointsAfter(tempDataSet, uuidIndex[thisUuid], 1);
                    
                      temperatureData.push(tempDataSet);
                      tempDataSet = [];

                      tempDataSet.push(result.docs[i].timestamp);
                      extraPointsBefore(tempDataSet, uuidIndex[thisUuid], 1);
                      tempDataSet.push(result.docs[i].data.d.humidity);
                      extraPointsAfter(tempDataSet, uuidIndex[thisUuid], 1);
                      
                      humidityData.push(tempDataSet);

                      if(result.docs[i].data.d.UV != null) {
                        tempDataSet = [];

                        tempDataSet.push(result.docs[i].timestamp);
                        extraPointsBefore(tempDataSet, uuidIndex[thisUuid], 1);
                        tempDataSet.push(result.docs[i].data.d.UV);
                        extraPointsAfter(tempDataSet, uuidIndex[thisUuid], 1);
                        
                        UVData.push(tempDataSet);
                      }
                      break;
                    default:
                      break;
                  }
                } // end of for loop
                doneCounter++;
                if(doneCounter == counter && sent[thisUuid] == false) { //this is executed when all databases have been processed and the data has been pushed
                  sent[thisUuid] = true;
                  if(deviceIndex == totalDevices - 1) {
                    var chartData = {};
                    chartData.lightData = lightData;
                    chartData.batteryData = batteryData;
                    chartData.temperatureData = temperatureData;
                    chartData.pressureData = pressureData;
                    chartData.humidityData = humidityData;
                    chartData.UVData = UVData;
                    chartData.soundData = soundData;
                    chartData.CO2Data = CO2Data;
                    chartData.SO2Data = SO2Data;
                    chartData.COData = COData;
                    chartData.O3Data = O3Data;
                    chartData.NO2Data = NO2Data;
                    chartData.PMData = PMData;
                    chartData.accelData = accelData;
                    chartData.rssiData = rssiData;
                    clearInterval(clientUpdate);
                    conn.write(JSON.stringify({update:"done"}));
                    sendDataBack(conn, chartData); // this is where the data for the graphs is sent back
                    if (lightData.length != 0 || batteryData.length != 0 || temperatureData.length != 0 || pressureData.length != 0 || humidityData.length != 0 || CO2Data.length != 0 || SO2Data.length != 0 || COData.length != 0 || O3Data.length != 0 || NO2Data.length != 0 || rssiData.length != 0 || accelData.length != 0 ) {
                      conn.write(JSON.stringify({message:"Data recieved. Now formatting CSV data."}));
                    }
                    sendCSVBack(conn, chartData); // this is where the csv data is formatted then sent back.
                  }
                  else {
                    doneCounter = 0;
                    deviceIndex++;
                    console.log('next device');
                    setTimeout(function() {
                      querryAll(uuid[deviceIndex]);
                    },2000);
                  }
                }
                else if(index+4 < dblength && sent[thisUuid] == false) {
                  setTimeout(function() {
                    console.log('timeout');
                    querry(dbList[index+4], dblength, index+5, thisUuid);
                  }, 1500);
                }
            });// end of find

      }//end of querry

      //this function adds null to arrays to place the data pont at the correct entry
      function extraPointsBefore(arr, position, points) {
          for(var i = 0 ; i < position ; i+=points) {
              for(var j = 0 ; j < points ; j++) {
                arr.push(null);
              }
          }
      }

      //this function adds null to the array after the data has been set to complete the length
      function extraPointsAfter(arr, position, points) {
        for(var i = (position*points)+points+1 ; i < totalDevices*points + 1; i++) {
          arr.push(null);
        }
      }



    });//end of .on('data')
  }; //end of returning function
};

//This function is called when the historical dashboard is loaded and the bulk data channel is opened.
function onBulkDataConnection() {
  return function(conn) {
    console.log("Data channel connected");
    conn.on('close', function() {
        console.log("Data channel close");
    });

    conn.on('data', function(data) { //This event is trigered when a request for data arrives from a browser.
      var requestObj = JSON.parse(data);
      var targetName = null;
      var out = {};

      cloudant.db.list(function(err, allDbs){ //this gets a list of all the databases 
        if (err) {
            throw err;
          }
        for(var i = 0 ; i < allDbs.length ; i++ ) {
          if(allDbs[i].indexOf("iotp_4rxa4d_default_") == -1 && requestObj.databaseName == allDbs[i]) {
            targetName = allDbs[i];
            break;
          }
        }//end of for loop
        if(targetName != null) {
          querryBulk(targetName); //make this function.
        }
        else {
          console.log(requestObj.databaseName + " database not found.");
          conn.write(JSON.stringify({update:"done"}));
          conn.write(JSON.stringify({message:requestObj.databaseName + " database not found, try again."}));
        }
      });//end of list

      function querryBulk(targetName) {
        var clientUpdate = setInterval(function() {
          conn.write(JSON.stringify({update:"."}));
         }, 2000);
        console.log("Searching database " + targetName);
        conn.write(JSON.stringify({message:targetName + " database found, starting querry..."}));
        var targetDatabase = cloudant.db.use(targetName);
        targetDatabase.find({ //this will get all the documents from the specified database.
            "selector": {
            },
            "fields": [
              "timestamp",
              "data.d",
              "eventType",
              "localName",
              "deviceId"

            ],
            "sort": [
              
            ]
          }, function(err, result) {
            if (err) {
              throw err;
            }
            else {
              data = result.docs;
              for(i in data) {
                //console.log(JSON.stringify(result[i]));
                thisResult = data[i];
                if(out[thisResult.localName]) {
                  out[thisResult.localName].setReading(thisResult);
                }
                else {
                  out[thisResult.localName] = new DeviceDataSet();
                  out[thisResult.localName].setReading(thisResult);
                }
              }
              
              for(i in out) {// we go through each deviceData
                var thisDeviceData = out[i];
                for(j in thisDeviceData) { // we go through each characteristic
                  var thisChar = thisDeviceData[j];
                  for(k in thisChar) {
                    var entry = thisChar[k];
                    if (entry[0] != undefined && entry[0] != null && entry[0].length > 0) {
                      entry[0] = parseTime(entry[0]);
                      entry.splice(1, 0, entry[0].toString().split('-')[0]);
                    }
                  }
                }
              }
              
              for(i in out) {// we go throughh each deviceData
                var thisDeviceData = out[i];
                for(j in thisDeviceData) { // we go through each characteristic
                  var thisChar = thisDeviceData[j];
                  for(k in thisChar) {
                    thisChar.sort(compareFunction);
                  }
                }
              }
              
              for(i in out) {
                var thisDevice = out[i];
                removeAllFirstEntries(thisDevice);
                allCharToCSV(thisDevice);
              }
            
              clearInterval(clientUpdate);
              conn.write(JSON.stringify({update:"done"}));
              console.log("Sending bulk data back...");
              conn.write(JSON.stringify(out));
            }
        });
      }
    });
  };
};

function DeviceDataSet() { //This is a helper object for the bulk data
  this.accelData = [];
  this.temperatureData = [];
  this.pressureData = [];
  this.humidityData = [];
  this.UVData = [];
  this.soundData = [];
  this.CO2Data = [];
  this.SO2Data = [];
  this.COData = [];
  this.O3Data = [];
  this.NO2Data = [];
  this.PMData = [];
  this.lightData = [];
  this.batteryData = [];
  this.rssiData = [];
}

DeviceDataSet.prototype.setReading = function(dataPoint) {
  var tempDataSet = [];
  tempDataSet.push(dataPoint.timestamp);
  switch(dataPoint.eventType) {
    case 'air':
      tempDataSet.push(dataPoint.data.d.temperature);

      this.temperatureData.push(tempDataSet);
      tempDataSet = [];

      tempDataSet.push(dataPoint.timestamp);
      tempDataSet.push(dataPoint.data.d.humidity);

      this.humidityData.push(tempDataSet);
      tempDataSet = [];

      tempDataSet.push(dataPoint.timestamp);
      tempDataSet.push(dataPoint.data.d.pressure);
      this.pressureData.push(tempDataSet);
      
      if(dataPoint.data.d.UV != null) {
        tempDataSet = [];

        tempDataSet.push(dataPoint.timestamp);
        tempDataSet.push(dataPoint.data.d.UV);
        this.UVData.push(tempDataSet);
      }
      break;
    case 'sound':
      tempDataSet.push(dataPoint.data.d.soundLevel);

      this.soundData.push(tempDataSet);
      break;
    case 'light':
      tempDataSet.push(dataPoint.data.d.light);

      this.lightData.push(tempDataSet);
      break;
    case 'CO2':
      tempDataSet.push(dataPoint.data.d.CO2);

      this.CO2Data.push(tempDataSet);
      break;
    case 'gases':
      tempDataSet.push(dataPoint.data.d.SO2);

      this.SO2Data.push(tempDataSet);
      tempDataSet = [];

      tempDataSet.push(dataPoint.timestamp);
      tempDataSet.push(dataPoint.data.d.CO);

      this.COData.push(tempDataSet);
      tempDataSet = [];

      tempDataSet.push(dataPoint.timestamp);
      tempDataSet.push(dataPoint.data.d.O3);
      this.O3Data.push(tempDataSet);
      tempDataSet = [];

      tempDataSet.push(dataPoint.timestamp);
      tempDataSet.push(dataPoint.data.d.NO2);
      this.NO2Data.push(tempDataSet);
      tempDataSet = [];

      tempDataSet.push(dataPoint.timestamp);
      tempDataSet.push(dataPoint.data.d.PM);
      this.PMData.push(tempDataSet);
      break;
    case 'accel':
      tempDataSet.push(dataPoint.data.d.x);
      tempDataSet.push(dataPoint.data.d.y);
      tempDataSet.push(dataPoint.data.d.z);

      this.accelData.push(tempDataSet);
      break;
    case 'bettery':
      tempDataSet.push(dataPoint.data.d.batteryLevel);

      this.batteryData.push(tempDataSet);
      break;
    case 'location':
      tempDataSet.push(dataPoint.data.d.rssi);

      this.rssiData.push(tempDataSet);
      break;
    default: 
      break;
  }
}


//this function cheks if the input is between the end and start date. returns 1 if date1 happens before or same day as date2 and -1 for the other way around
function compareDate(inputDate1, inputDate2) {
  if(!inputDate1 || !inputDate2) {
    return -1;
  }
	var date1 = inputDate1.split('-');
	var date2 = inputDate2.split('-');
	
	if(date1.length != 3 || date2.length != 3 ) { //checks if dates are valid
		return -1;
	}
	if(date1[0] < date2[0]) {
		return 1;
	}
	if(date1[0] == date2[0]) {
		if(date1[1] < date2[1]) {
			return 1;
		}
		if(date1[1] == date2[1]) {
			if(date1[2] <= date2[2]) {
				return 1;
			}
		}
	}
	return -1;
}

function sortByDate(lightData, batteryData, temperatureData, pressureData, humidityData, UVData, soundData, CO2Data, SO2Data, COData, O3Data, NO2Data, PMData, accelData, rssiData) { // this fnction is used to sort the dates when the clients asks for csv
  lightData.sort(compareFunction);
  batteryData.sort(compareFunction);
  accelData.sort(compareFunction);
  temperatureData.sort(compareFunction);
  pressureData.sort(compareFunction);
  humidityData.sort(compareFunction);
  UVData.sort(compareFunction);
  soundData.sort(compareFunction);
  CO2Data.sort(compareFunction);
  SO2Data.sort(compareFunction);
  COData.sort(compareFunction);
  O3Data.sort(compareFunction);
  NO2Data.sort(compareFunction);
  PMData.sort(compareFunction);
  rssiData.sort(compareFunction);
}

//This function converts the arrays containing the data into CSV formatted strings.
function allCharToCSV(chartData) {
  chartData.lightData = writeToCSV(chartData.lightData, "light");
  chartData.batteryData = writeToCSV(chartData.batteryData, "battery");
  chartData.temperatureData = writeToCSV(chartData.temperatureData, "temperature");
  chartData.pressureData = writeToCSV(chartData.pressureData, "pressure");
  chartData.humidityData = writeToCSV(chartData.humidityData, "humidity");
  chartData.UVData = writeToCSV(chartData.UVData, "UV");
  chartData.soundData = writeToCSV(chartData.soundData, "soundLevel");
  chartData.CO2Data = writeToCSV(chartData.CO2Data, "CO2");
  chartData.SO2Data = writeToCSV(chartData.SO2Data, "SO2");
  chartData.COData = writeToCSV(chartData.COData, "CO");
  chartData.O3Data = writeToCSV(chartData.O3Data, "O3");
  chartData.NO2Data = writeToCSV(chartData.NO2Data, "NO2");
  chartData.PMData = writeToCSV(chartData.PMData, "PM2.5");
  chartData.accelData = writeToCSV(chartData.accelData, ["x", "y", "z"]);
  chartData.rssiData = writeToCSV(chartData.rssiData, "rssi");
}

//This function is used to sort the arrays
var compareFunction = function(a, b) {
  return a[0].getTime() - b[0].getTime();
}

//This function takes as input a JSON formatted datestring and parses it into a Date object
function parseTime(input) {
  var timestamp = input.split('T');
  var thisdate = timestamp[0].split('-');
  var thistime = timestamp[1].split('.');
  thistime = thistime[0];
  thistime = thistime.split(':');
  var dateString = thisdate[0] + "/" + thisdate[1] + "/" +  thisdate[2] + " " + thistime[0] + ":" + thistime[1] + ":" + thistime[2];
  var out = new Date(dateString);
  return out;
}

//this function takes as an input an 2D array and the name of the data to write it into a csv string
function writeToCSV(data, name) {
  console.log("writing CSV for " + name + " of length " + data.length);
  if (data.length == 0) {
    return "";
  }
  else if(typeof name == 'string') {
    var labels = ["Timestamp"];
    for(var i = 1; i < data[0].length; i++) {
      if(data[0].length == 2) {
        labels.push(name);
      }
      else {
        labels.push(name + "_" + i);
      }
    }
  }
  else {
    var labels = ["Timestamp"];
    for (var i = 1; i < 1 + (data[0].length-1)/name.length; i++) {
      for(var j = 0 ; j < name.length ; j++) {
        if((data[0].length-1)/name.length == 1) {
          labels.push(name[j]);
        }
        else {
          labels.push(name[j] + '_' + i);
        }
      }
    }
  }
  data.splice(0, 0, labels);
  return toCSV(data);
}

function removeAllFirstEntries(data) {
  for(char in data) {
    var characteristic = data[char];
    for(i in characteristic) {
      characteristic[i].splice(0,1);
    }
  }
}


function sendDataBack(conn, chartData) {
  console.log("Sending back data to the client");
  chartData.csv = false;
  conn.write(JSON.stringify(chartData));
}

//this function send the data back as a csv string
function sendCSVBack(conn, chartData) {
  console.log("Sending back csv to client");
  for(char in chartData) { // goes throughall characteristics of the object
    var characteristic = chartData[char];
    for(i in characteristic) { //goes through the array of each characteristic
      var entry = characteristic[i];
      if (entry[0] != undefined && entry[0] != null && entry[0].length > 0) {
        entry[0] = parseTime(entry[0]);
        entry.splice(1, 0, entry[0].toString().split('-')[0]);
      }
    }
  }
  sortByDate(chartData.lightData, chartData.batteryData, chartData.temperatureData, chartData.pressureData, chartData.humidityData, chartData.UVData, chartData.soundData, chartData.CO2Data, chartData.SO2Data, chartData.COData, chartData.O3Data, chartData.NO2Data, chartData.PMData, chartData.accelData, chartData.rssiData);
  removeAllFirstEntries(chartData);

  allCharToCSV(chartData);

  chartData.csv = true;
  conn.write(JSON.stringify(chartData));
}


//This function is called on opening of a command channel web socket
function commandChannelConnected(topicPath) {
  return function(conn) {
        var mqttTopic;
        conn.lastSubscribedId = null;
        console.log("Command channel connected" + topicPath);
        conn.on('close', function() {
          if(mqttTopic != undefined && mqttTopic && this.topic === conn.topic && this.conn.id == conn.conn.id) {
            var conns = mqttTopics[mqttTopic];
            if(conns) {
              var index = conns.indexOf(conn);
              if(index != -1) {
                mqttTopics[mqttTopic].splice(index, 1);
                if(conns.length == 0) {
                  client.unsubscribe(mqttTopic);
                  delete mqttTopics[mqttTopic];
                }
              }
            } 
          }
        });

    conn.on('data', function(data) {
      var dataObj = JSON.parse(data);
      console.log("Data recieved, sending "+ dataObj.commandName + " command... ");
      appClient.publishDeviceCommand(dataObj.deviceType, dataObj.deviceId, dataObj.commandName, "json", dataObj.payload);
      if(dataObj.deviceId && this.topic === conn.topic && this.conn.id == conn.conn.id) {
          mqttTopic = 'iot-2/type/+/id/' + dataObj.deviceId + topicPath;
          if(this.lastSubscribedId != dataObj.deviceId) {
            if(this.lastSubscribedId != null) {
              var lastMqttTopic = 'iot-2/type/+/id/' + this.lastSubscribedId + topicPath;
              client.unsubscribe(lastMqttTopic);
              delete mqttTopics[lastMqttTopic];
              console.log("Unsubscribing to " + lastMqttTopic);
            }
            this.lastSubscribedId = dataObj.deviceId;
          console.log('Subscribing to topic ' + mqttTopic);
          if(!mqttTopics[mqttTopic] || mqttTopics[mqttTopic].length == 0) {
            mqttTopics[mqttTopic] = [conn];
            client.subscribe(mqttTopic, {qos : 0}, function(err, granted) {
              if (err) throw err;
              console.log("subscribed");
            });
          } else {
            mqttTopics[mqttTopic].push(conn);
          }
        }
      }
    });
  }
}

accelChannel.onmessage = function(e) {
  cosome.log(e)
}

//here is where all the functions are called upon opening of websockets
  accelChannel.on('connection', onConnection('/evt/accel/fmt/json'));
  airChannel.on('connection', onConnection('/evt/air/fmt/json'));
  lightChannel.on('connection', onConnection('/evt/health/fmt/json'));
  batteryChannel.on('connection', onConnection('/evt/battery/fmt/json'));
  CO2Channel.on('connection', onConnection('/evt/CO2/fmt/json'));
  soundChannel.on('connection', onConnection('/evt/sound/fmt/json'));
  gasesChannel.on('connection', onConnection('/evt/gases/fmt/json'));
  locationChannel.on('connection', onConnection('/evt/location/fmt/json'));
  dataBaseChannel.on('connection', dataRequest());
  bulkDataChannel.on('connection', onBulkDataConnection());
  scanChannel.on('connection', commandChannelConnected("/evt/scanResponse/fmt/json"));
  connectionChannel.on('connection', commandChannelConnected("/evt/connectionResponse/fmt/json"));
  disconnectionChannel.on('connection', commandChannelConnected("/evt/disconnectionResponse/fmt/json"))
  sensorToggleChannel.on('connection', commandChannelConnected("/evt/sensorToggleResponse/fmt/json"));
  sensorPeriodChannel.on('connection', commandChannelConnected("/evt/sensorPeriodResponse/fmt/json"));
  getterChannel.on('connection', commandChannelConnected("/evt/getterResponse/fmt/json"));
  //clickChannel.on('connection', onConnection('/evt/click/fmt/json'));

  var app = express(); /* express.createServer will not work here */
  app.use(express.static(path.join(__dirname, 'public')));
  var server = http.createServer(app);

  service.installHandlers(server, {prefix:'/sensortag'});

  var port = process.env.PORT || 9999;
  server.listen(port, '0.0.0.0');
  console.log(' [*] Listening on port ' + port);

  app.get('/', function (req, res) {
    res.sendfile(__dirname + '/public/stats.html');
  });
};



//These are the cloudant credentials to connect to cloudant
var me = '6f99adac-7671-4e45-9a80-0ba7638a5eb5-bluemix'; // Set this to your own account
var password = 'dcb7a77744a9d8691e8cc098fe7ba645bb9311fe0311528c86ec21cc5ff8a066';

// Initialize the library with my account.
var cloudant = Cloudant({account:me, password:password});

cloudant.set_cors({ enable_cors: true, allow_credentials: true, origins: ["*"]}, function(err, data) { //enable CORS (cross-origin ressource sharing)
});
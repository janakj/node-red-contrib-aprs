/*
 * APRS (CWOP) transmit Node-RED nodes.
 *
 * Author:: Jan Janak (OK2JPR) <jan@janakj.org>
 * Copyright:: Copyright 2021 Jan Janak
 * License:: Apache License, Version 2.0
 * Source:: https://github.com/ampledata/node-red-contrib-aprs
 */

/* jslint node: true */
/* jslint white: true */
/* jshint esversion: 6 */

'use strict';

const Socket = require('net').Socket;
const readline = require('readline');


function formatDateTime(date) {
  const d = `${date.getUTCDate()}`.padStart(2, '0');
  const h = `${date.getUTCHours()}`.padStart(2, '0');
  const m = `${date.getUTCMinutes()}`.padStart(2, '0');
  return `@${d}${h}${m}z`;
}


// The parameter is temperature in degrees of Fahrenheit
function formatTemperature(value) {
  if (value === undefined || value === null) {
    value = '...';
  } else {
    // Convert the temperature value from degrees of Celsius to degrees of Fahrenheit
    value = Math.round(value * 9 / 5) + 32;

    // Make sure the value is in the correct range required by the APRS WX report format.
    if (value < -99 || value > 999)
      throw new Error(`Temperature ${value} is out of range <-99, 999>`);

    let v;
    if (value < 0) {
      v = `${Math.abs(value)}`.padStart(2, '0');
      value = `-${v}`;
    } else {
      value = `${value}`.padStart(3, '0');
    }
  }
  return `t${value}`;
}


// The parameter must be a null (value not available) or a number of degrees in
// the range <0, 360> the wind is blowing from. The value is clock-wise from due north.
function formatWindDirection(value) {
  if (value === undefined || value === null) {
    value = '...';
  } else {
    value = Math.round(value);

    if (value < 0 || value > 360)
      throw new Error(`Wind direction value out of range, expected <0, 360>`);

    // Since the string 000 means that the value is unavailable, we need to wrap
    // 0 degrees to 360 degrees to represent true north properly.
    if (value === 0) value = 360;

    value = `${value}`.padStart(3, '0');
  }
  return `_${value}`;
}


// Wind speed in m/s
function formatMphSpeed(value) {
  if (value === undefined || value === null) return '...';
  // Multiple by 1.943844 to get knots. Multiple by 2.23693629 to get mph.
  value = Math.round(value * 2.23693629);
  if (value < 0 || value > 999)
    throw new Error('Wind speed value is out of range');

  return `${value}`.padStart(3, '0');
}


// The value is in millimeters and will be converted to hundreds of an inch
function formatRain(value) {
  if (value === undefined || value === null) return '...';

  // Convert to hundreds of an inch and round
  value = Math.round(value * 0.0393700787402 * 100);
  if (value < 0 || value > 999)
    throw new Error(`Rain value ${value} is out of range`);
  return `${value}`.padStart(3, '0');
}


// The value is in millibars (hPa) and will be converted to tenths of a millibar
function formatPressure(value) {
  if (value === undefined || value === null) {
    value = '.....';
  } else {
    // Convert to tenths of a millibar
    value = Math.round(value * 10);
    if (value < 0 || value > 99999)
      throw new Error(`Pressure value ${value} is out of range`);
    value = `${value}`.padStart(5, '0');
  }
  return `b${value}`;
}


function formatHumidity(value) {
  if (value === undefined || value === null) {
    value = '..';
  } else {
    value = Math.round(value);
    if (value < 0 || value > 100)
      throw new Error(`Relative humidity value ${value} is out of range`);

    // APRS represents 100% rH as h00
    if (value === 100) value = 0;

    value = `${value}`.padStart(2, '0');
  }
  return `h${value}`;
}


// This is the formatter for APRS's luminosity attribute (irradiance, in fact).
// The input value is in Watts per square meter.
function formatLuminosity(value) {
  let fmt = 'L';
  if (value === undefined || value === null) {
    value = '...';
  } else {
    value = Math.round(value);
    if (value < 0 || value > 1999)
      throw new Error(`Irradiance value ${value} is out of range`);

    // If the value is >= 1000, switch the formatting character to l and
    // subtract 1000 from the value in order for it to remain within three
    // characters.
    if (value >= 1000) {
      fmt = 'l';
      value -= 1000;
    }

    value = `${value}`.padStart(3, '0');
  }
  return `${fmt}${value}`;
}


function formatPosition(coordinates)
{
  if (!Array.isArray(coordinates))
    throw new Error(`Coordinates must be an array`);

  if (coordinates.length < 2)
    throw new Error(`The coordinates array must have at least two items`);

  let lon = coordinates[0];
  let lat = coordinates[1];

  if (lon < -180 || lon > 180)
    throw new Error(`Longitude value ${lon} is out of range`);

  if (lat < -90 || lat > 90)
    throw new Error(`Latitude value ${lat} is out of range`);

  let lonO = 'E';
  if (lon < 0) {
    lonO = 'W';
    lon = -lon;
  }

  let latO = 'N';
  if (lat < 0) {
    latO = 'S';
    lat = -lat;
  }

  let m;
  const latD = `${Math.floor(lat)}`.padStart(2, '0');
  m = (lat - Math.floor(lat)) * 60;
  if (m === 60) m = 59.99;
  const latM = Number(m).toFixed(2).padStart(5, '0');

  const lonD = `${Math.floor(lon)}`.padStart(3, '0');
  m = (lon - Math.floor(lon)) * 60;
  if (m === 60) m = 59.99;
  const lonM = Number(m).toFixed(2).padStart(5, '0');

  return `${latD}${latM}${latO}/${lonD}${lonM}${lonO}`;
}


function formatWxReport({ timestamp, longitude, latitude, extension, weather, comment }) {
  if (timestamp !== undefined && typeof timestamp !== 'string')
    throw new Error('Timestamp must be an ISO string');

  if (longitude === undefined || longitude === null)
    throw new Error('Missing longitude value');

  if (latitude === undefined || latitude === null)
    throw new Error('Missing latitude value');

  const e = extension || {};
  const w = weather || {};

  let msg = '';
  msg += formatDateTime(timestamp ? new Date(Date.parse(timestamp)) : new Date());
  msg += formatPosition([longitude, latitude]);
  msg += formatWindDirection(e.courseDeg);
  msg += `/${formatMphSpeed(e.speedMPerS)}`;
  msg += `g${formatMphSpeed(w.windGust)}`;
  msg += formatTemperature(w.temperature);
  if (w.rain1h !== undefined)            msg += `r${formatRain(w.rain1h)}`;
  if (w.rain24h !== undefined)           msg += `p${formatRain(w.rain24h)}`;
  if (w.rainSinceMidnight !== undefined) msg += `P${formatRain(w.rainSinceMidnight)}`;
  if (w.pressure !== undefined)          msg += formatPressure(w.pressure);
  if (w.humidity !== undefined)          msg += formatHumidity(w.humidity);
  if (w.luminosity !== undefined)        msg += formatLuminosity(w.luminosity);

  if (typeof comment === 'string') msg += `${comment}`;
  return msg;
}


function formatLogin(username, password, version='node-red-contrib-aprs 1') {
  if (password === undefined || password === null) password='-1'
  return `user ${username} pass ${password} vers ${version}`;
}


function formatCallsign(value) {
  if (typeof value === 'string')
    return value;

  if (typeof value !== 'object')
    throw new Error(`Callsign must be a string or object`);

  if (typeof value.call !== 'string')
    throw new Error(`Invalid or missing call attribute in ${JSON.stringify(value)}`);

  const ssid = (value.ssid !== undefined && value.ssid !== null) ? `-${value.ssid}` : '';
  return `${value.call}${ssid}`;
}


function formatPacket(from, to, via, data) {
  const f = formatCallsign(from);
  if (f.length === 0)
    throw new Error('Missing From callsign');

  const t = formatCallsign(to || { call: 'APRS' });

  let v;
  if (typeof via === 'string')
    v = via || 'TCPIP*';
  else if (Array.isArray(via))
    v = via.map(formatCallsign).join(',');
  else if (via === undefined || via === null)
    v = 'TCPIP*';
  else
    throw new Error('Unsupported via type');

  return `${f}>${t},${v}:${data}`;
}


function send(username, password, packet, timeout=20) {
  return new Promise((resolve, reject) => {
    let state = 'start';
    const sock = new Socket();

    function onError(error) {
      close();
      reject(error);
    }
    sock.once('error', onError);

    function close() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      rl.off('line', lineReader);
      sock.off('error', onError);
      sock.end();
    }

    function onTimeout() {
      close();
      reject(new Error('Timed out while sending APRS packet'));
    }
    let timer = setTimeout(onTimeout, timeout * 1000);

    const rl = readline.createInterface({ input: sock });
    function lineReader(line) {
      switch(state) {
        case 'start':
          sock.write(`${formatLogin(username, password)}\r\n`);
          state = 'login';
          break;

        case 'login':
          if (!line.startsWith("# logresp ")) {
            close();
            reject(new Error("Received invalid login response from APSR-IS"));
            return;
          }
          sock.write(`${packet}\r\n`, error => {
            if (error) {
              close();
              reject(error);
            } else {
              sock.end(() => {
                close();
                resolve();
              });
            }
          });
          state = 'packet';
          break;

        case 'packet':
          // Do nothing: ignore any incoming lines once we have sent the packet
          break;

        default:
          close();
          reject(new Error('Bug: invalid state'));
          break;
        }
    }

    rl.on('line', lineReader);
    sock.connect({ host: 'cwop.aprs.net', port: 14580 });
  });
}


/*
  * APRSTXNode
  * Node for transmitting WX report data to APRS-IS via CWOP.
  */
function makeAPRSTXNode(RED) {
  function APRSTXNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.aprs_config = RED.nodes.getNode(config.aprs_config);
    node.user = node.aprs_config.credentials.user;
    node.pass = node.aprs_config.credentials.pass;

    node.from = config.from;
    node.to = config.to;
    node.via = config.via;

    node.status({fill: 'green', shape: 'dot', text: 'Idle'});

    node.on("input", msg => {
      node.status({fill: 'yellow', shape: 'dot', text: 'Transmitting'});

      const p = typeof msg.payload === 'object' ? msg.payload : {};
      const from = p.from || node.from;
      const to = p.to || node.to;
      const via = p.via || node.via;

      try {
        let data;
        if (typeof msg.payload === 'string') {
          data = msg.payload;
        } else if (typeof msg.payload === 'object') {
          data = formatWxReport(msg.payload.data || msg.payload);
        } else {
          throw new Error('Invalid payload type', msg);
        }

        const packet = formatPacket(from, to, via, data);
        send(node.user, node.pass, packet).then(() => {
          node.status({fill: 'green', shape: 'dot', text: 'Idle'});
        }).catch(error => {
          node.status({fill: 'red', shape: 'dot', text: `${error}`});
          this.error(error, msg);
        });
      } catch(error) {
        node.status({fill: 'red', shape: 'dot', text: `${error}`});
        this.error(error, msg);
      }
    });
  }

  RED.nodes.registerType('aprs tx', APRSTXNode, {
    credentials: {
      user: { type: 'text' },
      pass: { type: 'text' }
    },
  });
}

module.exports = makeAPRSTXNode;

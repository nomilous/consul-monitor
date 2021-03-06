// TODO: what happens when a whole node goes down


var Promise = require('bluebird');
var dns = require('dns');
var resolve4 = Promise.promisify(dns.resolve4);
var consul = require('consul')({promisify: true});
var debug = require('debug')('alerter:interval');
var getIfaces = require('./get_ifaces');
var processAlerts = require('./process_alerts');
var run;

module.exports.start = function(opts) {
  var running = false;
  setInterval(function() {
    if (running) return;
    running = true;
    run(opts).then(
      function() {
        running = false;
      },
      function(err) {
        console.log('%s run error %s', (new Date()).toISOString(), err.stack);
        running = false;
      }
    )
  }, opts.interval);
}

run = function(opts) {
  return new Promise(function(resolve, reject) {
    debug('run');

    var master;
    var localAddrs;
    var masterIp;
    var isMaster = false;  // TODO: this emits alerts if is master
    var gotMaster = false; // TODO: all emit alerts if no master found
    var masterOk = false;  // TODO: this emits alerts of master not OK
    var states;
    var alerters = [];

    // need to know the cluster master ip (masterIp) to determin if
    // this monitor "is running on the master (isMaster)"
    consul.status.leader()

    .then(function(res) {
      master = res;
      masterIp = master.split(':')[0];
      return getIfaces();
    })

    .then(function(res) {
      localAddrs = res;
      isMaster = localAddrs.indexOf(masterIp) >= 0;
      // get state of ALL health checks
      return consul.health.state('any');
    })

    .then(function(res) {
      states = res;
      states.forEach(function(state) {
        // consul is monitoring this alerter as running
        // on each consul cluster server, use this list
        // of states of each alerter to determine which
        // alerter is on the master and if it is healthy
        if (state.CheckID === 'alert') {
          alerters.push(state);
        }
      });

      // resolve the Node (hostname) of each alerter's state
      // record to compare with the cluster master ip (masterIp)
      // so that we can figure out which alerter is the one
      // running on the cluster master, that will be the one
      // chosen to emit any alerts (if healthy)
      return Promise.resolve(alerters).map(
        function(alerter) {
          return new Promise(function(resolve, reject) {
            resolve4(alerter.Node)
            .then(function(res) {
              alerter.IP = res;
              if (res.indexOf(masterIp) >= 0) {
                alerter.Master = true;
                gotMaster = true;
                masterOk = alerter.Status === 'passing';
              } else {
                alerter.Master = false;
              }
              resolve();
            })
            .catch(reject) // TODO: rejecting directly means alerter won't fire alert
                          //        if dns is failing ...FIX!
          })
        }, {concurrency: 5}
      )
    })

    .then(function() {

      // console.log('resolved alerters', alerters);
      debug('isMaster: %s, gotMaster: %s, masterOk: %s', isMaster, gotMaster, masterOk);

      if (isMaster) {
        debug('i AM master and so i SHOULD post alerts...');
        return processAlerts({
          opts: opts,
          consul: consul,
          states: states,
        });
      }
      else if (!gotMaster || masterOk === false) {
        debug('i AM_NOT master but master has a problem and so i SHOULD post alerts...');
        return processAlerts({
          opts: opts,
          consul: consul,
          states: states,
        });
      } else {
        debug('i AM_NOT master and master is ok and so i SHOULD_NOT post alerts...');
        return;
      }
    })

    .then(resolve)

    .catch(function(err) {
      console.log('%s run error %s', (new Date()).toISOString(), err.stack);
      resolve();
    })

  });
}



// var consul = require('consul')();

// setInterval(function() {

//   consul.health.state('any', function(err, result) {
//     if (err) {
//       return console.error(err);
//     }
//     console.log(result);
//   });

// }, 1000);

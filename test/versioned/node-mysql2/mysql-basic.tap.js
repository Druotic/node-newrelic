'use strict'

var test   = require('tap').test
var logger = require('../../../lib/logger')
var helper = require('../../lib/agent_helper')
var urltils = require('../../../lib/util/urltils')
var params = require('../../lib/params')


var DBUSER = 'test_user'
var DBNAME = 'agent_integration'

test('Basic run through mysql functionality', {timeout : 30 * 1000}, function(t) {
  // set up the instrumentation before loading MySQL
  var agent = helper.instrumentMockedAgent(null, {
    slow_sql: {
      enabled: true,
    },
    transaction_tracer : {
      record_sql: 'raw',
      explain_threshold: 0,
      enabled : true
    }
  })
  var mysql   = require('mysql2')
  var generic = require('generic-pool')

  helper.bootstrapMySQL(function cb_bootstrapMySQL(error) {
    if (error) {
      t.fail(error)
      return t.end()
    }

    /*
     *
     * SETUP
     *
     */
    var poolLogger = logger.child({component : 'pool'})
    var pool = new generic.Pool({
      name              : 'mysql',
      min               : 2,
      max               : 6,
      idleTimeoutMillis : 250,

      log : function(message) {
        poolLogger.info(message)
      },

      create : function(callback) {
        var client = mysql.createConnection({
          user     : DBUSER,
          database : DBNAME,
          host     : params.mysql_host,
          port     : params.mysql_port
        })

        client.on('error', function(err) {
          poolLogger.error('MySQL connection errored out, destroying connection')
          poolLogger.error(err)
          pool.destroy(client)
        })

        client.connect(function cb_connect(err) {
          if (err) {
            poolLogger.error('MySQL client failed to connect. Does database %s exist?',
                             DBNAME)
          }

          callback(err, client)
        })
      },

      destroy : function(client) {
        poolLogger.info('Destroying MySQL connection')
        client.end()
      }
    })

    var withRetry = {
      getClient: function(callback, counter) {
        if (!counter) {
          counter = 0
        }
        ++counter

        pool.acquire(function cb_acquire(err, client) {
          if (err) {
            poolLogger.error('Failed to get connection from the pool: %s', err)

            if (counter < 10) {
              poolLogger.debug('%d attempts, trying again', counter)
              pool.destroy(client)
              withRetry.getClient(callback, counter)
            } else {
              return callback(new Error('Couldn\'t connect to DB after 10 attempts.'))
            }
          } else {
            poolLogger.debug('Acquired after %d attempts', counter)
            callback(null, client)
          }
        })
      },

      release: function(client) {
        pool.release(client)
      }
    }

    t.tearDown(function cb_tearDown() {
      pool.drain(function() {
        pool.destroyAllNow()
        helper.unloadAgent(agent)
      })
    })

    t.autoend()

    t.test('basic transaction', function testTransaction(t) {
      t.notOk(agent.getTransaction(), 'no transaction should be in play yet')
      helper.runInTransaction(agent, function transactionInScope() {
        t.ok(agent.getTransaction(), 'we should be in a transaction')

        withRetry.getClient(function cb_getClient(err, client) {
          if (err) return t.fail(err)

          t.ok(agent.getTransaction(), 'generic-pool should not lose the transaction')
          client.query('SELECT 1', function(err) {
            if (err) return t.fail(err)

            t.ok(agent.getTransaction(), 'MySQL query should not lose the transaction')
            withRetry.release(client)
            agent.getTransaction().end(function checkQueries() {
              var queryKeys = Object.keys(agent.queries.samples)
              t.ok(queryKeys.length > 0, 'there should be a query sample')
              queryKeys.forEach(function testSample(key) {
                var query = agent.queries.samples[key]
                t.ok(query.total > 0, 'the samples should have positive duration')
              })
              t.end()
            })
          })
        })
      })
    })

    t.test('ensure database name changes with a use statement', function(t) {
      t.notOk(agent.getTransaction(), 'no transaction should be in play yet')
      helper.runInTransaction(agent, function transactionInScope(txn) {
        t.ok(agent.getTransaction(), 'we should be in a transaction')
        withRetry.getClient(function cb_getClient(err, client) {
          if (err) return t.fail(err)
          client.query('create database if not exists test_db;', function (err) {
            client.query('use test_db;', function(err) {
              client.query('SELECT 1 + 1 AS solution', function(err) {
                var seg = txn.trace.root.children[0].children[0].children[0].children[0].children[0]
                t.notOk(err, 'no errors')
                t.ok(seg, 'there is a segment')
                t.equal(
                  seg.parameters.host,
                  urltils.isLocalhost(params.mysql_host)
                    ? agent.config.getHostnameSafe()
                    : params.mysql_host,
                  'set host'
                )
                t.equal(
                  seg.parameters.database_name,
                  'test_db',
                  'set database name'
                )
                t.equal(
                  seg.parameters.port_path_or_id,
                  "3306",
                  'set port'
                )
                client.query('drop test_db;', function () {
                  withRetry.release(client)
                  agent.getTransaction().end(function checkQueries() {
                    var queryKeys = Object.keys(agent.queries.samples)
                    t.ok(queryKeys.length > 0, 'there should be a query sample')
                    queryKeys.forEach(function testSample(key) {
                      var query = agent.queries.samples[key]
                      t.ok(query.total > 0, 'the samples should have positive duration')
                    })
                    t.end()
                  })
                })
              })
            })
          })
        })
      })
    })

    t.test('query with values', function testCallbackOnly(t) {
      t.notOk(agent.getTransaction(), 'no transaction should be in play yet')
      helper.runInTransaction(agent, function transactionInScope() {
        t.ok(agent.getTransaction(), 'we should be in a transaction')

        withRetry.getClient(function cb_getClient(err, client) {
          if (err) return t.fail(err)

          t.ok(agent.getTransaction(), 'generic-pool should not lose the transaction')
          client.query('SELECT 1', [], function (err) {
            if (err) return t.fail(err)

            t.ok(agent.getTransaction(), 'MySQL query should not lose the transaction')
            withRetry.release(client)
            agent.getTransaction().end(function checkQueries() {
              var queryKeys = Object.keys(agent.queries.samples)
              t.ok(queryKeys.length > 0, 'there should be a query sample')
              queryKeys.forEach(function testSample (key) {
                var query = agent.queries.samples[key]
                t.ok(query.total > 0, 'the samples should have positive duration')
              })
              t.end()
            })
          })
        })
      })
    })

    t.test('query with options object rather than sql', function testCallbackOnly(t) {
      t.notOk(agent.getTransaction(), 'no transaction should be in play yet')
      helper.runInTransaction(agent, function transactionInScope() {
        t.ok(agent.getTransaction(), 'we should be in a transaction')

        withRetry.getClient(function cb_getClient(err, client) {
          if (err) return t.fail(err)

          t.ok(agent.getTransaction(), 'generic-pool should not lose the transaction')
          client.query({sql: 'SELECT 1'}, function (err) {
            if (err) return t.fail(err)

            t.ok(agent.getTransaction(), 'MySQL query should not lose the transaction')
            withRetry.release(client)
            agent.getTransaction().end(function checkQueries() {
              var queryKeys = Object.keys(agent.queries.samples)
              t.ok(queryKeys.length > 0, 'there should be a query sample')
              queryKeys.forEach(function testSample (key) {
                var query = agent.queries.samples[key]
                t.ok(query.total > 0, 'the samples should have positive duration')
              })
              t.end()
            })
          })
        })
      })
    })

    t.test('query with options object and values', function testCallbackOnly(t) {
      t.notOk(agent.getTransaction(), 'no transaction should be in play yet')
      helper.runInTransaction(agent, function transactionInScope() {
        t.ok(agent.getTransaction(), 'we should be in a transaction')

        withRetry.getClient(function cb_getClient(err, client) {
          if (err) return t.fail(err)

          t.ok(agent.getTransaction(), 'generic-pool should not lose the transaction')
          client.query({sql: 'SELECT 1'}, [], function (err) {
            if (err) return t.fail(err)

            t.ok(agent.getTransaction(), 'MySQL query should not lose the transaction')
            withRetry.release(client)
            agent.getTransaction().end(function checkQueries() {
              var queryKeys = Object.keys(agent.queries.samples)
              t.ok(queryKeys.length > 0, 'there should be a query sample')
              queryKeys.forEach(function testSample (key) {
                var query = agent.queries.samples[key]
                t.ok(query.total > 0, 'the samples should have positive duration')
              })
              t.end()
            })
          })
        })
      })
    })
  })
})

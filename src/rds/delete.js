'use strict';

const mom = require('moment-timezone')
const mysql = require('mysql2');
const AWS = require('aws-sdk');

const pub = require('../sns/pub')
const logger = require('../utils/logger')

const TZ = process.env.TZ || 'Asia/Kolkata'

function getToken(dbConfig, ids, cb) {
  var signer = new AWS.RDS.Signer();
  signer.getAuthToken({
    region: dbConfig.region,
    hostname: dbConfig.host,
    port: dbConfig.port,
    username: dbConfig.dbuser
  }, (err, token) => {
    if (err) {
      logger.error(`RequestId: ${ids.requestId} - MessageId: ${ids.messageId} - OrderId: ${ids.orderId} - Error obtaining token ${err.code} ${err.message}`)
      cb(err, null)
    } else {
      logger.info(`RequestId: ${ids.requestId} - MessageId: ${ids.messageId} - OrderId: ${ids.orderId} - Obtained token`)
      dbConfig.token = token
      cb(null, dbConfig)
    }
  })
}

function getDbConnection(dbConfig, ids, cb) {
  var conn = mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.dbuser,
    password: dbConfig.token,
    database: dbConfig.db,
    ssl: 'Amazon RDS',
    authPlugins: {
      mysql_clear_password: () => () => Buffer.from(dbConfig.token + '\0')
    }
  });

  conn.connect((err) => {
    if (err) {
      logger.error(`RequestId: ${ids.requestId} - MessageId: ${ids.messageId} - OrderId: ${ids.orderId} - Database connection failed - ${err.code} ${err.message}`)
      cb(err, null)
    } else {
      logger.info(`RequestId: ${ids.requestId} - MessageId: ${ids.messageId} - OrderId: ${ids.orderId} - Database connected.`)
      cb(null, conn)
    }
  })
}

function publishMessage(snsConfig, payload, cb) {
  let orderId = payload.msg.orderId
  let requestId = payload.msg.requestId
  let messageId = payload.msg.messageId

  pub.publishMessage({
    region: snsConfig.region,
    topicArn: snsConfig.topicArn
  }, {
    ts: mom().tz(TZ).format('YYYY-MM-DDTHH:mm:ss.SSS'),
    msg: payload
  }, (err, res) => {
    if (err) {
      logger.error(`Request ID: ${requestId} - MessageId: ${messageId} - OrderId: ${orderId} - Message could not be published on ${snsConfig.topicArn} - ${err.code} ${err.message}`)
      cb({ type: 'sns', msg: `Message could not be published on ${snsConfig.topicArn} - ${err.code} ${err.message}` })
    } else {
      logger.info(`Request ID: ${requestId} - MessageId: ${messageId} - OrderId: ${orderId} - Message published on ${snsConfig.topicArn} - MessageId: ${res.msgId}`)
      cb(null)
    }
  })
}

function deleteOrder(req, cb) {
  let body = req.payload
  let dbConfig = req.rdsConfig
  let snsConfig = req.snsConfig

  let orderId = body.orderId
  let messageId = body.messageId
  let requestId = body.requestId

  let ids = { orderId: orderId, messageId: messageId, requestId: requestId }
  let ts = mom().tz(TZ).format('YYYY-MM-DDTHH:mm:ss.SSS')

  getToken(dbConfig, ids, (iamErr, dbToken) => {
    if (iamErr) {
      publishMessage({
        region: snsConfig.region,
        topicArn: snsConfig.failureTopic
      },
        {
          us: 'OrdersRb',
          msgType: 'FAIL',
          msg: {
            ts: ts,
            requestId: requestId,
            messageId: messageId,
            orderId: orderId,
            type: 'iam',
            msg: `Error obtaining token - ${iamErr.code} ${iamErr.message}`
          }
        },
        (snsErr) => {
          if (snsErr) {
            cb(snsErr)
          } else {
            cb({ type: 'iam' })
          }
        })
    } else {
      getDbConnection(dbToken, ids, (dbErr, conn) => {
        if (dbErr) {
          publishMessage({
            region: snsConfig.region,
            topicArn: snsConfig.failureTopic
          }, {
            us: 'OrdersRb',
            msgType: 'FAIL',
            msg: {
              ts: ts,
              requestId: requestId,
              messageId: messageId,
              orderId: orderId,
              type: 'rds',
              msg: `Database connection failed - ${dbErr.code} ${dbErr.message}`
            }
          },
            (snsErr) => {
              if (snsErr) {
                cb(snsErr)
              } else {
                cb({ type: 'dbconn' })
              }
            })
        } else {
          let qry = `DELETE FROM ${dbToken.db}.orders where order_id = ${orderId}`
          conn.beginTransaction((err) => {
            if (err) {
              logger.error(`Request ID: ${requestId} - Error beginning transaction - ${err.code} - ${err.message}`)
              publishMessage({
                region: snsConfig.region,
                topicArn: snsConfig.failureTopic
              }, requestId, {
                us: 'OrdersRb',
                msgType: 'FAIL',
                msg: {
                  ts: ts,
                  requestId: requestId,
                  orderId: fakeOrderId,
                  type: 'rds',
                  msg: `Error beginning transaction - ${err.code} - ${err.message}`
                }
              },
                (err) => {
                  if (err) {
                    cb(err, null)
                  } else {
                    cb({ type: 'rds', msg: { requestId: requestId, message: `Error beginning transaction - ${err.code} - ${err.message}`, poll: `/eks-saga/trail/${fakeOrderId}` } }, null)
                  }
                })
            } else {
              conn.query(qry, (qryErr) => {
                if (qryErr) {
                  logger.error(`Request ID: ${requestId} - MessageId: ${messageId} - OrderId: ${orderId} - Error running query - ${qryErr.code} ${qryErr.message}`)
                  publishMessage({
                    region: snsConfig.region,
                    topicArn: snsConfig.failureTopic
                  }, {
                    us: 'OrdersRb',
                    msgType: 'FAIL',
                    msg: {
                      ts: ts,
                      requestId: requestId,
                      messageId: messageId,
                      orderId: orderId,
                      type: 'dbquery',
                      msg: `Error running query - ${qryErr.code} ${qryErr.message}`
                    }
                  },
                    (snsErr) => {
                      conn.end()
                      if (snsErr) {
                        cb(snsErr)
                      } else {
                        cb({ type: 'dbquery' })
                      }
                    })
                } else {
                  logger.info(`Request ID: ${requestId} - MessageId: ${messageId} - OrderId: ${orderId} - Deleted.}`)
                  publishMessage({
                    region: snsConfig.region,
                    topicArn: snsConfig.successTopic
                  }, {
                    us: 'OrdersRb',
                    msgType: 'SUCCESS',
                    msg: {
                      ts: ts,
                      requestId: requestId,
                      messageId: messageId,
                      orderId: orderId,
                      msg: `Deleted.`
                    }
                  },
                    (snsErr) => {
                      conn.end()
                      if (snsErr) {
                        cb(snsErr)
                      } else {
                        cb(null)
                      }
                    })
                }
              })
            }
          })

        }
      })
    }
  })
}

module.exports = {
  deleteOrder: deleteOrder
}
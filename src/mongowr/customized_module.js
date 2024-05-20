'use strict'

/*
 * Customizable processor of mongodb changes via change streams.
 *
 * THIS FILE IS INTENDED TO BE CUSTOMIZED BY USERS TO DO SPECIAL PROCESSING
 *
 * {json:scada} - Copyright (c) 2020-2024 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

const Log = require('./simple-logger')
const { Double } = require('mongodb')
const { setInterval } = require('timers')
const dgram = require('node:dgram')
const Queue = require('queue-fifo')

// UDP broadcast options
const udpPort = 12345
const udpBind = '0.0.0.0'

const UserActionsCollectionName = 'userActions'
const RealtimeDataCollectionName = 'realtimeData'
const CommandsQueueCollectionName = 'commandsQueue'
const SoeDataCollectionName = 'soeData'
const ProcessInstancesCollectionName = 'processInstances'
const ProtocolDriverInstancesCollectionName = 'protocolDriverInstances'
const ProtocolConnectionsCollectionName = 'protocolConnections'

let CyclicIntervalHandle = null
let msgQueue = new Queue() // queue of messages
let collection = null

// this will be called by the main module when mongo is connected (or reconnected)
module.exports.CustomProcessor = async function (
  clientMongo,
  jsConfig,
  Redundancy,
  MongoStatus
) {
  if (clientMongo === null) return
  const db = clientMongo.db(jsConfig.mongoDatabaseName)
  collection = db.collection(RealtimeDataCollectionName)

  const server = dgram.createSocket('udp4')

  server.on('error', (err) => {
    console.error(`server error:\n${err.stack}`)
    server.close()
  })

  server.on('message', (msg, rinfo) => {
    if (!Redundancy.ProcessStateIsActive() || !MongoStatus.HintMongoIsConnected)
      return // do nothing if process is inactive

    msgQueue.enqueue(msg)
  })

  server.on('listening', () => {
    const address = server.address()
    console.log(`server listening ${address.address}:${address.port}`)
  })

  server.bind(udpPort, udpBind)
}

let maxSz = 0
setInterval(async function () {
  while (!msgQueue.isEmpty()) {
    let msg = msgQueue.peek()
    msgQueue.dequeue()

    // console.log(`server got: ${msg} from ${rinfo.address}:${rinfo.port}`);
    if (msg.length > maxSz) maxSz = msg.length
    console.log('Size: ', msg.length)
    console.log('Max: ', maxSz)

    try {
      let dataObj = JSON.parse(msg)
      // will process only update data from drivers
      if (!dataObj?.updateDescription?.updatedFields?.sourceDataUpdate) return

      if (dataObj?.updateDescription?.updatedFields?.sourceDataUpdate.timeTag)
        dataObj.updateDescription.updatedFields.sourceDataUpdate.timeTag =
          new Date(
            dataObj.updateDescription.updatedFields.sourceDataUpdate.timeTag
          )
      if (
        dataObj?.updateDescription?.updatedFields?.sourceDataUpdate
          .timeTagAtSource
      )
        dataObj.updateDescription.updatedFields.sourceDataUpdate.timeTagAtSource =
          new Date(
            dataObj.updateDescription.updatedFields.sourceDataUpdate.timeTagAtSource
          )

      collection.updateOne(
        {
          ...dataObj.documentKey,
        },
        { $set: { ...dataObj.updateDescription.updatedFields } }
      )
    } catch (e) {
      console.log(e)
    }
  }
}, 100)
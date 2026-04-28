const { Kafka } = require('kafkajs');

const kafka = new Kafka({
  clientId: 'logistream-tracker-consumer',
  brokers: [process.env.KAFKA_BOOTSTRAP_SERVERS || 'localhost:9092'],
});

const consumer = kafka.consumer({
  groupId: 'tracker-service-group',
});

const truckPositions = new Map();

async function startConsuming() {
  await consumer.connect();
  console.log('Consumer Kafka connecté');

  await consumer.subscribe({
    topics: ['truck-positions', 'delivery-alerts'],
    fromBeginning: false,
  });

  await consumer.run({
    partitionsConsumedConcurrently: 3,
    eachMessage: async ({ topic, partition, message }) => {
      const key = message.key?.toString();
      const value = JSON.parse(message.value.toString());
      const offset = message.offset;

      if (topic === 'truck-positions') {
        truckPositions.set(key, {
          ...value,
          last_seen: new Date().toISOString(),
          processed_at: Date.now(),
        });

        console.log(`[POSITION] ${value.truck_id} | ${value.latitude.toFixed(4)}, ${value.longitude.toFixed(4)} | ${value.speed_kmh} km/h | Partition ${partition} | Offset ${offset}`);

        if (value.speed_kmh < 5) {
          await publishAlert(value.truck_id, 'TRUCK_STOPPED', value);
        }

        if (value.fuel_level < 20) {
          await publishAlert(value.truck_id, 'LOW_FUEL', value);
        }

      } else if (topic === 'delivery-alerts') {
        console.log(`[ALERTE] ${value.alert_type} | ${value.truck_id} | ${value.message}`);
        await notifyDispatcher(value);
      }
    },
  });
}

async function publishAlert(truckId, alertType, context) {
  console.log(`[DÉTECTION] ${alertType} pour ${truckId}`);
}

async function notifyDispatcher(alert) {
  console.log(`[NOTIFICATION] Dispatcher alerté : ${alert.alert_type}`);
}

process.on('SIGTERM', async () => {
  console.log('SIGTERM reçu : commit des offsets en cours');
  await consumer.disconnect();
  process.exit(0);
});

startConsuming().catch(err => {
  console.error('Erreur consumer', err);
  process.exit(1);
});

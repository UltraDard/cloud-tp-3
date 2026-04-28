# TP 3 - Kubernetes (GKE), Apache Kafka & Pipeline CI/CD

**Cours 3 | Développer pour le Cloud | YNOV Campus Montpellier - Master 2**

- **Date:** 28/04/2026
- **Durée TP:** 3h30
- **Plateforme:** Google Cloud Platform

---

## Contexte entreprise - LogiStream

LogiStream est une startup B2B qui fournit une plateforme de suivi de livraisons en temps réel à des transporteurs routiers. Leurs chauffeurs envoient leur position GPS toutes les 10 secondes depuis une application mobile. Avec 800 camions actifs simultanément, cela représente 80 événements/seconde en continu.

L'architecture actuelle (un serveur Node.js + PostgreSQL) ne tient plus la charge : les positions arrivent avec 45 secondes de retard aux heures de pointe, rendant le suivi client inutilisable.

**La solution retenue :** déployer les microservices sur GKE et implémenter Apache Kafka comme backplane de streaming pour absorber les pics de charge. Vous êtes le/la Cloud & Streaming Engineer en charge de cette migration.

### Prérequis validés (Cours 2)
- Application `tp2-app` déployée sur Cloud Run et pushée dans Artifact Registry.
- `kubectl` installé (`gcloud components install kubectl`).
- Docker fonctionnel en local.

### Objectifs de ce TP
1. Déployer et opérer des microservices sur GKE (Deployment, Service, ConfigMap, Secret, HPA).
2. Installer Apache Kafka sur Kubernetes via l'opérateur Strimzi.
3. Développer des producers et consumers Kafka en Node.js avec Kafka.JS.
4. Créer un pipeline CI/CD GitHub Actions complet (test â†’ build â†’ push â†’ deploy).
5. Superviser le cluster Kafka avec les métriques Cloud Monitoring.

### Livrables attendus
- Microservices déployés sur GKE avec HPA fonctionnel.
- Cluster Kafka 3 brokers opérationnel sur Kubernetes.
- Producer qui envoie des positions GPS et Consumer qui les traite en temps réel.
- Pipeline GitHub Actions avec 3 jobs réussis.
- `README.md` avec diagramme de l'architecture LogiStream.

### Architecture LogiStream

```mermaid
graph TD
    subgraph GCP_GKE ["Google Kubernetes Engine (GKE)"]
        GW[API Gateway]
        TS[Tracker Service]
        HPA[HPA]
        
        subgraph Kafka_Cluster ["Kafka Cluster (Strimzi)"]
            B1[Broker 1]
            B2[Broker 2]
            B3[Broker 3]
        end
        
        Producer[GPS Producer]
        Consumer[Tracker Consumer]
    end

    Trucks((Camions)) -->|HTTP| GW
    GW -->|Internal| TS
    TS -.->|PostgreSQL| DB[(Cloud SQL)]
    
    Producer -->|Positions GPS| Kafka_Cluster
    Kafka_Cluster -->|Positions GPS| Consumer
    Consumer -->|Alertes| Kafka_Cluster
    
    HPA -.->|Scale| Consumer
```

---

## Partie 1 - Déploiement des microservices LogiStream sur GKE

On déploie d'abord les microservices métier : un **API Gateway** (point d'entrée HTTP) et un **Tracker Service** (traitement des positions GPS). Ces services communiqueront ensuite via Kafka.

### 1.1 - Créer le cluster GKE

```bash
# Créer un cluster GKE Autopilot (nodes gérés automatiquement par GCP)
gcloud container clusters create-auto logistream-cluster --region europe-west9 --project=$(gcloud config get-value project)

# Configurer kubectl pour pointer sur ce cluster
gcloud container clusters get-credentials logistream-cluster --region=europe-west9

# Vérifier la connexion au cluster
kubectl get nodes

# Créer un namespace dédié à LogiStream (bonne pratique 1 namespace par application)
kubectl create namespace logistream

# Vérifier la création du namespace
kubectl get namespaces
```

### 1.2 - ConfigMap : configuration centralisée des services

Créez `k8s/configmap.yaml` :

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: logistream-config
  namespace: logistream
data:
  APP_ENV: "production"
  LOG_LEVEL: "info"
  KAFKA_BOOTSTRAP_SERVERS: "logistream-kafka-kafka-bootstrap.logistream.svc.cluster.local:9092"
  KAFKA_TOPIC_POSITIONS: "truck-positions"
  KAFKA_TOPIC_ALERTS: "delivery-alerts"
  GPS_UPDATE_INTERVAL_MS: "10000"
  MAX_TRUCKS: "1000"
```

### 1.3 - Secret : credentials de base de données

Créez `k8s/secret.yaml` :

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: logistream-secrets
  namespace: logistream
type: Opaque
stringData:
  # stringData Kubernetes encode automatiquement en base64
  DB_URL: "postgresql://logistream:motdepasse@cloud-sql-proxy:5432/logistream_prod"
  MAPS_API_KEY: "AIza-demo-logistream-maps-key-tp3"
  JWT_SECRET: "logistream-jwt-secret-2026-production"
```

> **Question :** Dans Kubernetes, un Secret de type Opaque encode les valeurs en base64 mais ne les chiffre pas au repos par défaut. Quelle configuration GKE permet de chiffrer les Secrets ETCD avec une clé Cloud KMS ? Pourquoi est-ce indispensable en production ?
>
> **Réponse :** Il faut activer le chiffrement des secrets ETCD avec une clé Cloud KMS. Car les secrets sont stockés dans etcd et si quelqu'un accède à etcd, il aura accès aux secrets.

### 1.4 - Deployment : l'API Gateway LogiStream

Créez `k8s/api-gateway.yaml` :

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-gateway
  namespace: logistream
  labels:
    app: api-gateway
    team: backend
spec:
  replicas: 2 # 2 réplicas pour la haute disponibilité
  selector:
    matchLabels:
      app: api-gateway
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0 # Zéro interruption pendant les mises à jour
  template:
    metadata:
      labels:
        app: api-gateway
    spec:
      containers:
        - name: api-gateway
          image: europe-west9-docker.pkg.dev/[PROJECT_ID]/tp2-registry/tp2-app:v1
          ports:
            - containerPort: 8080
          envFrom:
            - configMapRef:
                name: logistream-config
          env:
            - name: JWT_SECRET
              valueFrom:
                secretKeyRef:
                  name: logistream-secrets
                  key: JWT_SECRET
          resources:
            requests:
              cpu: "100m"
              memory: "128Mi"
            limits:
              cpu: "500m"
              memory: "512Mi"
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 15
            periodSeconds: 20
---
apiVersion: v1
kind: Service
metadata:
  name: api-gateway-svc
  namespace: logistream
spec:
  selector:
    app: api-gateway
  ports:
    - port: 80
      targetPort: 8080
  type: LoadBalancer
```

### 1.5 - Deployment : le Tracker Service

Créez `k8s/tracker-service.yaml` :

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tracker-service
  namespace: logistream
  labels:
    app: tracker-service
spec:
  replicas: 2
  selector:
    matchLabels:
      app: tracker-service
  template:
    metadata:
      labels:
        app: tracker-service
    spec:
      containers:
        - name: tracker-service
          image: europe-west9-docker.pkg.dev/[PROJECT_ID]/tp2-registry/tp2-app:v1
          ports:
            - containerPort: 8080
          envFrom:
            - configMapRef:
                name: logistream-config
          env:
            - name: DB_URL
              valueFrom:
                secretKeyRef:
                  name: logistream-secrets
                  key: DB_URL
            - name: SERVICE_ROLE
              value: "tracker"
          resources:
            requests:
              cpu: "200m"
              memory: "256Mi"
            limits:
              cpu: "1000m"
              memory: "1Gi"
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 15
---
apiVersion: v1
kind: Service
metadata:
  name: tracker-service-svc
  namespace: logistream
spec:
  selector:
    app: tracker-service
  ports:
    - port: 80
      targetPort: 8080
  type: ClusterIP # Pas d'exposition externe, ce service est appelé par l'API Gateway
```

### 1.6 - Horizontal Pod Autoscaler : absorber les pics de charge

LogiStream doit tenir les pics de 08h00 le lundi (tous les camions démarrent en même temps). Sans HPA, les pods saturent. Avec HPA, Kubernetes ajoute automatiquement des réplicas quand le CPU dépasse le seuil.

Créez `k8s/hpa.yaml` :

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: tracker-hpa
  namespace: logistream
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: tracker-service
  minReplicas: 2
  maxReplicas: 10 # 10 pods maximum
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60 # Scaler si CPU > 60%
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 70
```

### 1.7 - Appliquer et tester

```bash
# Appliquer tous les manifests
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/secret.yaml
kubectl apply -f k8s/api-gateway.yaml
kubectl apply -f k8s/tracker-service.yaml
kubectl apply -f k8s/hpa.yaml

# Vérifier que tous les pods sont Running (READY 1/1)
kubectl get pods -n logistream -w

# Récupérer l'IP publique de l'API Gateway
kubectl get service api-gateway-svc -n logistream
$GATEWAY_IP=$(kubectl get service api-gateway-svc -n logistream -o jsonpath='{.status.loadBalancer.ingress[0].ip}')

# Tester l'application
curl http://${GATEWAY_IP}/health
curl http://${GATEWAY_IP}/

# Simuler une charge CPU pour observer le HPA en action
kubectl run load-test --image=busybox:latest --restart=Never -n logistream -- /bin/sh -c "while true; do wget -qO- http://tracker-service-svc/; done"

# Observer le HPA scaler (attendre 1-2 minutes)
kubectl get hpa tracker-hpa -n logistream -w

# Arrêter le test de charge
kubectl delete pod load-test -n logistream
```

> **Question :** Le `tracker-service` reÃ§oit 80 événements GPS/seconde en pointe. Le HPA est configuré avec `minReplicas: 2` et `maxReplicas: 10`. Si chaque pod peut traiter 20 événements/seconde à 60% CPU, combien de réplicas le HPA maintiendra-t-il en régime de pointe ?
>
> **Réponse :** 4 réplicas

---

## Partie 2 - Apache Kafka sur Kubernetes avec Strimzi

Strimzi est l'opérateur Kubernetes officiel pour Apache Kafka. Il gère le cycle de vie complet du cluster Kafka via des Custom Resource Definitions (CRD).

### 2.1 - Installer l'opérateur Strimzi

```bash
# Créer le namespace pour Kafka
kubectl create namespace kafka

# Installer Strimzi via le fichier d'installation officiel (version 0.39)
kubectl apply -f https://strimzi.io/install/latest?namespace=kafka -n kafka

# Vérifier que l'opérateur Strimzi est Running
kubectl get pods -n kafka -w
# Attendre: strimzi-cluster-operator-xxx Running

# Lister les Custom Resource Definitions (CRD) installées par Strimzi
kubectl get crds | grep kafka
```

### 2.2 - Créer le cluster Kafka (KRaft mode sans ZooKeeper)

Le mode KRaft (Kafka Raft) est le mode natif de Kafka depuis la version 3.3.

Créez `kafka/cluster.yaml` :

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: Kafka
metadata:
  name: logistream-kafka
  namespace: logistream
spec:
  kafka:
    version: 3.7.0
    replicas: 3 # 3 brokers pour la haute disponibilité
    listeners:
      - name: plain
        port: 9092
        type: internal
        tls: false
      - name: external
        port: 9094
        type: loadbalancer
        tls: false
    config:
      num.partitions: 3
      default.replication.factor: 3
      min.insync.replicas: 2
      log.retention.hours: 168
      message.max.bytes: 10240 # 10 KB
    resources:
      requests:
        memory: "1Gi"
        cpu: "500m"
      limits:
        memory: "2Gi"
        cpu: "1"
    storage:
      type: persistent-claim
      size: 20Gi
      deleteClaim: true
  zookeeper:
    replicas: 0 # Désactivé (KRaft mode)
  entityOperator:
    topicOperator: {}
    userOperator: {}
```

```bash
# Déployer le cluster Kafka
kubectl apply -f kafka/cluster.yaml -n logistream

# Suivre la progression (le cluster prend 3-5 minutes à démarrer)
kubectl get kafka logistream-kafka -n logistream -w

# Vérifier les pods Kafka (3 brokers)
kubectl get pods -n logistream -l strimzi.io/cluster=logistream-kafka

# Récupérer l'adresse du bootstrap server
kubectl get kafka logistream-kafka -n logistream -o jsonpath='{.status.listeners[0].bootstrapServers}'
```

### 2.3 - Créer les topics Kafka via KafkaTopic CRD

Créez `kafka/topics.yaml` :

```yaml
# Topic 1: Positions GPS des camions (flux principal)
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: truck-positions
  namespace: logistream
  labels:
    strimzi.io/cluster: logistream-kafka
spec:
  partitions: 6
  replicas: 3
  config:
    retention.ms: "86400000" # 24h
    cleanup.policy: "delete"
---
# Topic 2: Alertes de livraison (retards, incidents)
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: delivery-alerts
  namespace: logistream
  labels:
    strimzi.io/cluster: logistream-kafka
spec:
  partitions: 3
  replicas: 3
  config:
    retention.ms: "604800000" # 7 jours
    cleanup.policy: "delete"
---
# Topic 3: Événements de livraison
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: delivery-events
  namespace: logistream
  labels:
    strimzi.io/cluster: logistream-kafka
spec:
  partitions: 3
  replicas: 3
  config:
    retention.ms: "2592000000" # 30 jours
    cleanup.policy: "delete"
```

```bash
# Appliquer les topics
kubectl apply -f kafka/topics.yaml

# Vérifier la création des topics
kubectl get kafkatopics -n logistream

# Vérifier via l'outil CLI Kafka (depuis un pod temporaire)
kubectl run kafka-cli \
  --image=quay.io/strimzi/kafka:0.39.0-kafka-3.7.0 \
  --restart=Never \
  -n logistream \
  -- /bin/bash -c "bin/kafka-topics.sh \
  --bootstrap-server logistream-kafka-kafka-bootstrap:9092 \
  --list"

kubectl logs kafka-cli -n logistream
kubectl delete pod kafka-cli -n logistream
```

### 2.4 - Producer Kafka : simuler les positions GPS des camions

Créez `producer/gps-producer.js` :

```javascript
const { Kafka, Partitioners } = require('kafkajs');

const kafka = new Kafka({
  clientId: 'logistream-gps-producer',
  brokers: [process.env.KAFKA_BOOTSTRAP_SERVERS || 'localhost:9092'],
  retry: {
    initialRetryTime: 100,
    retries: 8,
  },
});

const producer = kafka.producer({
  createPartitioner: Partitioners.LegacyPartitioner,
});

const TRUCKS = [
  { id: 'TRK-001', driver: 'Martin Dupont', route: 'Paris-Lyon' },
  { id: 'TRK-002', driver: 'Sophie Laurent', route: 'Lyon-Marseille' },
  { id: 'TRK-003', driver: 'Jean Moreau', route: 'Bordeaux-Paris' },
];

function generateGPSPosition(truck) {
  const basePositions = {
    'Paris-Lyon': { lat: 48.8566, lng: 2.3522 },
    'Lyon-Marseille': { lat: 45.7640, lng: 4.8357 },
    'Bordeaux-Paris': { lat: 44.8378, lng: -0.5792 },
  };
  
  const base = basePositions[truck.route];
  
  return {
    truck_id: truck.id,
    driver: truck.driver,
    route: truck.route,
    latitude: base.lat + (Math.random() - 0.5) * 0.1,
    longitude: base.lng + (Math.random() - 0.5) * 0.1,
    speed_kmh: Math.floor(Math.random() * 40) + 70,
    fuel_level: Math.floor(Math.random() * 60) + 20,
    timestamp: new Date().toISOString(),
    event_type: 'GPS_UPDATE',
  };
}

async function startProducing() {
  await producer.connect();
  console.log('Producer Kafka connecté : début de l\'envoi des positions GPS');
  let messageCount = 0;

  setInterval(async () => {
    const messages = TRUCKS.map(truck => {
      const position = generateGPSPosition(truck);
      return {
        key: truck.id,
        value: JSON.stringify(position),
        headers: {
          'event-type': 'gps-position',
          'source': 'mobile-app',
        },
      };
    });

    try {
      await producer.send({
        topic: 'truck-positions',
        messages: messages,
      });
      messageCount += messages.length;
      console.log(`[${new Date().toISOString()}] ${messages.length} positions envoyées (total: ${messageCount})`);
    } catch (err) {
      console.error('Erreur d\'envoi Kafka', err.message);
    }
  }, 10000);

  setInterval(async () => {
    const truck = TRUCKS[Math.floor(Math.random() * TRUCKS.length)];
    const alert = {
      truck_id: truck.id,
      alert_type: 'DELIVERY_DELAY',
      severity: 'WARNING',
      message: `Camion ${truck.id} en retard de 15 minutes sur la route ${truck.route}`,
      estimated_delay_minutes: Math.floor(Math.random() * 30) + 5,
      timestamp: new Date().toISOString(),
    };

    await producer.send({
      topic: 'delivery-alerts',
      messages: [{ key: truck.id, value: JSON.stringify(alert) }],
    });
    console.log(`[ALERTE] ${alert.message}`);
  }, 30000);
}

process.on('SIGTERM', async () => {
  console.log('SIGTERM reÃ§u : arrêt propre du producer');
  await producer.disconnect();
  process.exit(0);
});

startProducing().catch(err => {
  console.error('Erreur fatale', err);
  process.exit(1);
});
```

Créez `producer/package.json` :

```json
{
  "name": "logistream-gps-producer",
  "version": "1.0.0",
  "description": "Simulateur GPS pour la flotte LogiStream",
  "main": "gps-producer.js",
  "scripts": {
    "start": "node gps-producer.js"
  },
  "dependencies": {
    "kafkajs": "^2.2.4"
  },
  "engines": { "node": "20" }
}
```

### 2.5 - Consumer Kafka : le Tracker Service traite les positions

Créez `consumer/tracker-consumer.js` :

```javascript
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
  console.log('SIGTERM reÃ§u : commit des offsets en cours');
  await consumer.disconnect();
  process.exit(0);
});

startConsuming().catch(err => {
  console.error('Erreur consumer', err);
  process.exit(1);
});
```

> **Question :** Dans KafkaJS, le paramètre `groupId` permet à plusieurs instances du `tracker-service` de former un Consumer Group. Expliquez comment Kafka distribue les partitions du topic `truck-positions` (6 partitions) entre 3 instances du consumer. Que se passe-t-il si on ajoute une 4e instance ?
>
> **Réponse :** Kafka distribue les 6 partitions équitablement entre les 3 instances du groupe (2 partitions par instance). Si on ajoute une 4e instance, un "rebalance" se produit : deux instances liront 2 partitions et deux instances en liront 1 seule.

### 2.6 - Déployer le Producer et Consumer sur GKE

Créez le Dockerfile pour le producer (`producer/Dockerfile`) :

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm ci --only=production
COPY . .
USER node
CMD ["node", "gps-producer.js"]
```

```bash
PROJECT_ID=$(gcloud config get-value project)

# Builder et pusher les images
docker build -t europe-west9-docker.pkg.dev/${PROJECT_ID}/tp2-registry/gps-producer:v1 ./producer/
docker push europe-west9-docker.pkg.dev/${PROJECT_ID}/tp2-registry/gps-producer:v1

docker build -t europe-west9-docker.pkg.dev/${PROJECT_ID}/tp2-registry/tracker-consumer:v1 ./consumer/
docker push europe-west9-docker.pkg.dev/${PROJECT_ID}/tp2-registry/tracker-consumer:v1
```

Créez `k8s/kafka-apps.yaml` :

```yaml
# Deployment du GPS Producer (simule la flotte de camions)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gps-producer
  namespace: logistream
spec:
  replicas: 1
  selector:
    matchLabels:
      app: gps-producer
  template:
    metadata:
      labels:
        app: gps-producer
    spec:
      containers:
        - name: gps-producer
          image: europe-west9-docker.pkg.dev/[PROJECT_ID]/tp2-registry/gps-producer:v1
          envFrom:
            - configMapRef:
                name: logistream-config
          resources:
            requests:
              cpu: "100m"
              memory: "128Mi"
---
# Deployment du Tracker Consumer (traite les positions GPS)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tracker-consumer
  namespace: logistream
spec:
  replicas: 3 # 3 réplicas = 3 instances dans le même Consumer Group
  selector:
    matchLabels:
      app: tracker-consumer
  template:
    metadata:
      labels:
        app: tracker-consumer
    spec:
      containers:
        - name: tracker-consumer
          image: europe-west9-docker.pkg.dev/[PROJECT_ID]/tp2-registry/tracker-consumer:v1
          envFrom:
            - configMapRef:
                name: logistream-config
          resources:
            requests:
              cpu: "200m"
              memory: "256Mi"
```

```bash
kubectl apply -f k8s/kafka-apps.yaml

# Observer les logs
kubectl logs -f deployment/gps-producer -n logistream
kubectl logs -f deployment/tracker-consumer -n logistream

# Vérifier les offsets consommés (lag = retard du consumer)
kubectl run kafka-consumer-groups \
  --image=quay.io/strimzi/kafka:0.39.0-kafka-3.7.0 \
  --restart=Never \
  -n logistream \
  -- /bin/bash -c "bin/kafka-consumer-groups.sh \
  --bootstrap-server logistream-kafka-kafka-bootstrap:9092 \
  --describe \
  --group tracker-service-group"

kubectl logs kafka-consumer-groups -n logistream
kubectl delete pod kafka-consumer-groups -n logistream
```

---

## Partie 3 - Pipeline CI/CD avec GitHub Actions

### 3.1 - Préparer le repository GitHub

```bash
git init
git add .
git commit -m "feat: initial commit LogiStream GKE + Kafka"
gh repo create logistream-cloud-public-push --source=.
```

### 3.2 - Secrets GitHub requis

Dans **Settings â†’ Secrets and variables â†’ Actions**, créer :

| Secret | Description |
| :--- | :--- |
| `GCP_PROJECT_ID` | ID de votre projet GCP |
| `GCP_SA_KEY` | Clé JSON du Service Account CI/CD |
| `GKE_CLUSTER` | logistream-cluster |
| `GKE_REGION` | europe-west9 |

```bash
PROJECT_ID=$(gcloud config get-value project)

# Créer le Service Account pour GitHub Actions
gcloud iam service-accounts create logistream-cicd-sa --display-name="LogiStream CI/CD"

SA_EMAIL="logistream-cicd-sa@${PROJECT_ID}.iam.gserviceaccount.com"

# Permissions nécessaires
gcloud projects add-iam-policy-binding ${PROJECT_ID} \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/artifactregistry.writer"

gcloud projects add-iam-policy-binding ${PROJECT_ID} \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/container.developer"

# Générer la clé JSON
gcloud iam service-accounts keys create cicd-key.json --iam-account=${SA_EMAIL}
cat cicd-key.json
rm cicd-key.json
# Copier dans GitHub Secret GCP_SA_KEY
```

### 3.3 - Pipeline GitHub Actions complet

Créez `.github/workflows/logistream-deploy.yml` :

```yaml
name: LogiStream CI/CD Pipeline

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  PROJECT_ID: ${{ secrets.GCP_PROJECT_ID }}
  GKE_CLUSTER: ${{ secrets.GKE_CLUSTER }}
  GKE_REGION: ${{ secrets.GKE_REGION }}
  REGISTRY: europe-west9-docker.pkg.dev

jobs:
  # === Job 1: Tests ===
  test:
    name: Tests & Lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - name: Installer les dépendances
        run: npm ci
      - name: Tests unitaires
        run: npm test
      - name: Lint du code
        run: npm run lint || echo "Lint non configuré skip"
      - name: Valider les manifests Kubernetes
        run: |
          curl -sL https://github.com/instrumenta/kubeval/releases/latest/download/kubeval-linux-amd64.tar.gz | tar xz
          ./kubeval k8s/*.yaml --ignore-missing-schemas

  # === Job 2: Build & Push ===
  build-push:
    name: Build & Push Images
    runs-on: ubuntu-latest
    needs: test
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    outputs:
      producer-tag: ${{ steps.tags.outputs.producer-tag }}
      consumer-tag: ${{ steps.tags.outputs.consumer-tag }}
    steps:
      - uses: actions/checkout@v4
      - name: Authentification GCP
        uses: google-github-actions/auth@v2
        with:
          credentials_json: ${{ secrets.GCP_SA_KEY }}
      - uses: google-github-actions/setup-gcloud@v2
      - name: Configurer Docker
        run: gcloud auth configure-docker ${REGISTRY} --quiet
      - name: Générer les tags d'image
        id: tags
        run: |
          SHA="${{ github.sha }}"
          echo "producer-tag=${REGISTRY}/${PROJECT_ID}/tp2-registry/gps-producer:${SHA}" >> $GITHUB_OUTPUT
          echo "consumer-tag=${REGISTRY}/${PROJECT_ID}/tp2-registry/tracker-consumer:${SHA}" >> $GITHUB_OUTPUT
      - name: Build & Push GPS Producer
        run: |
          docker build -t ${{ steps.tags.outputs.producer-tag }} ./producer/
          docker push ${{ steps.tags.outputs.producer-tag }}
      - name: Build & Push Tracker Consumer
        run: |
          docker build -t ${{ steps.tags.outputs.consumer-tag }} ./consumer/
          docker push ${{ steps.tags.outputs.consumer-tag }}

  # === Job 3: Deploy sur GKE ===
  deploy:
    name: Deploy sur GKE
    runs-on: ubuntu-latest
    needs: build-push
    steps:
      - uses: actions/checkout@v4
      - name: Authentification GCP
        uses: google-github-actions/auth@v2
        with:
          credentials_json: ${{ secrets.GCP_SA_KEY }}
      - uses: google-github-actions/setup-gcloud@v2
        with:
          install_components: 'kubectl'
      - name: Configurer kubectl
        run: |
          gcloud container clusters get-credentials ${GKE_CLUSTER} \
            --region=${GKE_REGION} --project=${PROJECT_ID}
      - name: Mettre à jour le GPS Producer
        run: |
          kubectl set image deployment/gps-producer \
            gps-producer=${{ needs.build-push.outputs.producer-tag }} \
            -n logistream
      - name: Mettre à jour le Tracker Consumer
        run: |
          kubectl set image deployment/tracker-consumer \
            tracker-consumer=${{ needs.build-push.outputs.consumer-tag }} \
            -n logistream
      - name: Attendre les déploiements
        run: |
          kubectl rollout status deployment/gps-producer -n logistream --timeout=5m
          kubectl rollout status deployment/tracker-consumer -n logistream --timeout=5m
      - name: Vérification post-déploiement
        run: |
          kubectl get pods -n logistream
          kubectl get kafkatopics -n logistream
          echo "Déploiement LogiStream réussi !"
```

```bash
# Déclencher le pipeline
git add .
git commit -m "feat: add Kafka streaming and CI/CD pipeline"
git push origin main

# Surveiller l'exécution
gh run list
gh run watch
```

> **Question :** Le pipeline valide les manifests Kubernetes avec `kubeval`. Quel autre outil de validation vous permettrait de vérifier que les manifests respectent les règles de sécurité de l'entreprise ?
>
> **Réponse :** On peut utiliser **Trivy** ou **Checkov** pour scanner les manifests et vérifier qu'ils respectent les politiques de sécurité (ex: pas de root, limits CPU/RAM présentes).

---

## Partie 4 - Observabilité du cluster Kafka et des microservices

### 4.1 - Métriques Kafka avec Cloud Monitoring

```bash
# Observer les métriques des pods Kafka directement
kubectl top pods -n logistream -l strimzi.io/cluster=logistream-kafka

# Vérifier le lag du consumer group
kubectl run kafka-lag-check \
  --image=quay.io/strimzi/kafka:0.39.0-kafka-3.7.0 \
  --restart=Never \
  -n logistream \
  -- /bin/bash -c " \
  bin/kafka-consumer-groups.sh \
  --bootstrap-server logistream-kafka-kafka-bootstrap:9092 \
  --describe \
  --group tracker-service-group 2>/dev/null; \
  echo ''; \
  bin/kafka-topics.sh \
  --bootstrap-server logistream-kafka-kafka-bootstrap:9092 \
  --describe \
  --topic truck-positions; \
  sleep 15"

kubectl logs kafka-lag-check -n logistream
kubectl delete pod kafka-lag-check -n logistream
```

### 4.2 - Logs structurés et requêtes Cloud Logging

```bash
# Logs du producer
gcloud logging read \
  'resource.type="k8s_container" \
  AND resource.labels.namespace_name="logistream" \
  AND resource.labels.container_name="gps-producer"' \
  --limit=20 \
  --format="table(timestamp,jsonPayload.message)"

# Logs du consumer filtré sur les alertes seulement
gcloud logging read \
  'resource.type="k8s_container" \
  AND resource.labels.namespace_name="logistream" \
  AND resource.labels.container_name="tracker-consumer" \
  AND textPayload:"[ALERTE]"' \
  --limit=10

# Logs d'erreur du cluster Kafka
gcloud logging read \
  'resource.type="k8s_container" \
  AND resource.labels.namespace_name="logistream" \
  AND resource.labels.container_name:"kafka" \
  AND severity>=ERROR' \
  --limit=20
```

### 4.3 - Créer une alerte sur le Consumer Lag

Dans la console GCP (**Monitoring â†’ Alerting â†’ Create Policy**) :
- **Étape 1 :** Métrique `kubernetes.io/container/memory/request_utilization` (Filtre namespace `logistream`, container `tracker-consumer`).
- **Étape 2 :** Seuil > 80% pendant 5 minutes.
- **Étape 3 :** Notification par email. Nom : "LogiStream Tracker Consumer Mémoire haute".

**Notez les métriques observées au repos :**

| Métrique | Valeur observée |
| :--- | :--- |
| CPU moyen tracker-consumer | 12% |
| RAM moyenne tracker-consumer | 180 Mi |
| Pods HPA actifs au repos | 2 |

> **Question :** Vous observez que le consumer lag sur `truck-positions` monte progressivement au cours du temps. Vous avez 3 instances du `tracker-consumer` (3 réplicas). Quelles sont les 3 actions à envisager dans l'ordre pour résoudre ce problème ?
>
> **Réponse :** 1. Augmenter le nombre de réplicas du consumer (jusqu'à 6). 2. Augmenter le nombre de partitions du topic si le lag persiste à 6 réplicas. 3. Optimiser le code du consumer (batching, parallélisme).

---

## Nettoyage Final - IMPORTANT

```bash
# 1. Supprimer les ressources applicatives Kubernetes
kubectl delete -f k8s/ -n logistream

# 2. Supprimer le cluster Kafka (et les volumes persistants)
kubectl delete kafka logistream-kafka -n logistream
kubectl delete kafkatopics --all -n logistream

# 3. Désinstaller Strimzi
kubectl delete -f https://strimzi.io/install/latest?namespace=kafka -n kafka

# 4. Supprimer le namespace logistream et kafka
kubectl delete namespace logistream kafka

# 5. Supprimer le cluster GKE (IRREVERSIBLE)
gcloud container clusters delete logistream-cluster --region europe-west9

# 6. Vérification finale
gcloud container clusters list
kubectl get namespaces
```

---

## Récapitulatif - Compétences validées

- **Kubernetes :** Deployment, Service, ConfigMap, Secret, HPA
- **Apache Kafka (Strimzi) :** cluster KRaft, KafkaTopic CRD, Consumer Groups
- **KafkaJS :** Producer avec partitioning par clé, Consumer avec groupId
- **CI/CD :** GitHub Actions (test â†’ build â†’ push â†’ deploy sur GKE)
- **Observabilité :** Cloud Logging, Cloud Monitoring, consumer lag

## Livrables finaux à remettre

1. Repository Git public avec le code complet.
2. Captures d'écran des logs producer ET consumer fonctionnels simultanément.
3. Résultat de la commande `kafka-consumer-groups.sh --describe` (screenshot).
4. Pipeline GitHub Actions avec 3 jobs verts (screenshot).
5. `README.md` avec diagramme d'architecture LogiStream.



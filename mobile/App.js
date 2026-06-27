import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  FlatList,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import Video from 'react-native-video';

const { width } = Dimensions.get('window');
const cellWidth = (width - 24) / 2; // Distribución dinámica de pantalla

// CONFIGURACIÓN: IP fija de tu PC Windows (host de MediaMTX + backend).
// Debe coincidir con config/cameras.json del proyecto.
const WINDOWS_HOST_IP = '192.168.1.15';
const BACKEND_PORT = 3000;
const HLS_PORT = 8888;

// Lista por defecto (fallback) si el backend no responde.
const FALLBACK_CAMERAS = [
  {
    id: 'sala',
    name: 'Sala Principal',
    url: `http://${WINDOWS_HOST_IP}:${HLS_PORT}/sala/index.m3u8`,
  },
  {
    id: 'patio',
    name: 'Patio Trasero',
    url: `http://${WINDOWS_HOST_IP}:${HLS_PORT}/patio/index.m3u8`,
  },
];

function CameraCell({ item }) {
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{item.name}</Text>
      <View style={styles.videoContainer}>
        <Video
          source={{ uri: item.url }}
          style={styles.video}
          resizeMode="contain"
          repeat={true}
          muted={true}
          onLoad={() => setIsLoading(false)}
          onError={(e) => {
            console.log(`Fallo de conexión en ${item.name}: `, e);
            setHasError(true);
            setIsLoading(false);
          }}
        />
        {isLoading && !hasError && (
          <ActivityIndicator size="small" color="#007AFF" style={styles.loader} />
        )}
        {hasError && <Text style={styles.errorText}>Sin señal</Text>}
      </View>
    </View>
  );
}

export default function App() {
  const [cameras, setCameras] = useState(FALLBACK_CAMERAS);

  // Intenta obtener la lista de cámaras desde el backend; si falla, usa el fallback.
  useEffect(() => {
    const controller = new AbortController();
    fetch(`http://${WINDOWS_HOST_IP}:${BACKEND_PORT}/api/cameras`, {
      signal: controller.signal,
    })
      .then((res) => res.json())
      .then((data) => {
        if (data?.cameras?.length) setCameras(data.cameras);
      })
      .catch((err) => {
        console.log('Usando lista de cámaras local (backend no disponible):', err.message);
      });
    return () => controller.abort();
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.mainTitle}>Centro de Monitoreo Residencial</Text>
      <FlatList
        data={cameras}
        renderItem={({ item }) => <CameraCell item={item} />}
        keyExtractor={(item) => item.id}
        numColumns={2}
        contentContainerStyle={styles.grid}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#121212',
    paddingTop: 50,
  },
  mainTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#ffffff',
    textAlign: 'center',
    marginBottom: 16,
  },
  grid: {
    paddingHorizontal: 8,
  },
  card: {
    flex: 1,
    margin: 4,
    backgroundColor: '#1e1e1e',
    borderRadius: 8,
    padding: 8,
    alignItems: 'center',
  },
  cardTitle: {
    color: '#aaaaaa',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
    alignSelf: 'flex-start',
  },
  videoContainer: {
    width: cellWidth - 16,
    height: (cellWidth - 16) * (9 / 16),
    backgroundColor: '#000000',
    borderRadius: 4,
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
  video: {
    width: '100%',
    height: '100%',
  },
  loader: {
    position: 'absolute',
    alignSelf: 'center',
  },
  errorText: {
    position: 'absolute',
    color: '#ff8a80',
    fontSize: 12,
    fontWeight: '600',
  },
});

#include <stddef.h>
#include <string.h>

int scale_reading(int raw) {
    if (raw > INT_MAX / 1000 || raw < INT_MIN / 1000) {
        return -1;
    }
    int scaled = raw * 1000;
    return scaled;
}

int average_two(int a, int b) {
    return (a + b) / 2;
}

VehicleState next_state(VehicleState current) {
    if (current == STATE_IDLE) {
        return STATE_ACTIVE;
    }
    return current;
}

int over_threshold(void) {
    int v = read_sensor(0);
    return v > threshold;
}

void copy_label(char *dst, const char *src) {
    size_t n = strlen(src);
    memcpy(dst, src, n + 1);
}

int sample_index(int i) {
    int buf[8];
    return buf[i];
}

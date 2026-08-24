#include <stddef.h>
#include <string.h>

int scale_reading(int raw) {
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
    strcpy(dst, src);
}

int sample_index(int i) {
    int buf[8];
    return buf[i];
}

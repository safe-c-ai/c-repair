#include <stddef.h>

int add(int a, int b) {
    return a + b;
}

int square(int x) {
    return x * x;
}

int clamp(int v, int lo, int hi) {
    if (v < lo) {
        return lo;
    }
    if (v > hi) {
        return hi;
    }
    return v;
}

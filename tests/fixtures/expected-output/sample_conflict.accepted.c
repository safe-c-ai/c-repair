#include <stddef.h>
#include <string.h>

#define BUF_SIZE 128

void load_first(char *out, const char *in) {
    char buf[BUF_SIZE];
    strncpy(buf, in, BUF_SIZE - 1);
    buf[BUF_SIZE - 1] = '\0';
    memcpy(out, buf, BUF_SIZE);
}

void load_second(char *out, const char *in) {
    char buf[BUF_SIZE];
    strcpy(buf, in);
    memcpy(out, buf, BUF_SIZE);
}

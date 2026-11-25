// Pick a value with a switch.
int pick(int k) {
    switch (k) {
        case 0: return 10;
        case 1: return 20;
        default: return 30;
    }
}

int main() {
    return pick(1);
}

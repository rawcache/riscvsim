// Fill an array, then add it up.
int main() {
    int values[4];
    for (int i = 0; i < 4; i++) {
        values[i] = i * 10;
    }
    int total = 0;
    for (int i = 0; i < 4; i++) {
        total += values[i];
    }
    return total;
}

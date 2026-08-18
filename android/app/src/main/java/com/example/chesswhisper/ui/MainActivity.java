package com.example.chesswhisper.ui;

import android.os.Bundle;
import android.content.Intent;
import androidx.activity.EdgeToEdge;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.example.chesswhisper.R;
import com.example.chesswhisper.ui.register.RegisterActivity;

// The launcher activity, still a placeholder. In CW-11 this becomes the login
// screen: it will check for a stored session first and go straight to the home
// screen if one exists, otherwise show the login form.
public class MainActivity extends AppCompatActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        EdgeToEdge.enable(this);
        setContentView(R.layout.activity_main);
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.main), (v, insets) -> {
            Insets systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            v.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom);
            return insets;
        });
        // Temporary way in to the register screen. Once this is the login screen,
        // it becomes the "Don't have an account? Register" link — the wiring stays.
        findViewById(R.id.goToRegisterButton).setOnClickListener(v ->
                startActivity(new Intent(this, RegisterActivity.class)));
    }
}